import { createInterface } from "readline";
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  statSync,
  readdirSync,
  writeFileSync,
} from "fs";
import * as path from "path";
import { ChildProcess, spawn, spawnSync } from "child_process";

const builtins = new Set(["echo", "exit", "type", "pwd", "cd", "complete", "jobs"]);
const autocompleteBuiltins = ["echo", "exit"];

const completionSpecs = new Map<string, string>();

type BackgroundJob = {
  jobNumber: number;
  pid: number;
  command: string;
  status: "Running" | "Done";
  process: ChildProcess;
};

type ShellToken = {
  value: string;
  quoted: boolean;
};

type RedirectTarget = {
  file: string;
  append: boolean;
};

type ParsedCommand = {
  tokens: ShellToken[];
  stdoutTarget: RedirectTarget | null;
  stderrTarget: RedirectTarget | null;
};

let lastTabCompletionLine: string | null = null;
const backgroundJobs: BackgroundJob[] = [];

function getExecutableMatches(prefix: string): string[] {
  const matches = new Set<string>();
  const pathEnv = process.env.PATH ?? "";
  const directories = pathEnv.split(path.delimiter);

  for (const directory of directories) {
    try {
      const entries = readdirSync(directory);

      for (const entry of entries) {
        if (!entry.startsWith(prefix)) {
          continue;
        }

        const fullPath = path.join(directory, entry);

        try {
          accessSync(fullPath, constants.X_OK);
          matches.add(entry);
        } catch {
          // Not executable or cannot be accessed.
        }
      }
    } catch {
      // PATH entry does not exist or cannot be read.
    }
  }

  return [...matches];
}

function longestCommonPrefix(values: string[]): string {
  if (values.length === 0) {
    return "";
  }

  let prefix = values[0];

  for (const value of values.slice(1)) {
    while (!value.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);

      if (prefix === "") {
        return "";
      }
    }
  }

  return prefix;
}

function getFilenameMatches(partialFilename: string): string[] {
  const lastSlashIndex = partialFilename.lastIndexOf("/");

  const directoryPath =
    lastSlashIndex === -1 ? "." : partialFilename.slice(0, lastSlashIndex + 1);

  const filenamePrefix =
    lastSlashIndex === -1
      ? partialFilename
      : partialFilename.slice(lastSlashIndex + 1);

  try {
    return readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(filenamePrefix))
      .map((entry) =>
        lastSlashIndex === -1
          ? entry.name
          : `${directoryPath}${entry.name}`,
      )
      .sort();
  } catch {
    return [];
  }
}

type PathCompletionMatch = {
  completion: string;
  display: string;
  lcpValue: string;
};

function getPathMatches(partialPath: string): PathCompletionMatch[] {
  const lastSlashIndex = partialPath.lastIndexOf("/");

  const directoryPath =
    lastSlashIndex === -1 ? "." : partialPath.slice(0, lastSlashIndex + 1);

  const entryPrefix =
    lastSlashIndex === -1
      ? partialPath
      : partialPath.slice(lastSlashIndex + 1);

  try {
    return readdirSync(directoryPath)
      .filter((entry) => entry.startsWith(entryPrefix))
      .map((entry): PathCompletionMatch | null => {
        const completedPath =
          lastSlashIndex === -1 ? entry : `${directoryPath}${entry}`;

        try {
          if (statSync(completedPath).isDirectory()) {
            return {
              completion: `${completedPath}/`,
              display: `${completedPath}/`,
              lcpValue: completedPath,
            };
          }

          return {
            completion: `${completedPath} `,
            display: completedPath,
            lcpValue: completedPath,
          };
        } catch {
          return null;
        }
      })
      .filter((match): match is PathCompletionMatch => match !== null)
      .sort((a, b) => a.display.localeCompare(b.display));
  } catch {
    return [];
  }
}

function getRegisteredCompleterResult(line: string): [string[], string] | null {
  const firstSpaceIndex = line.indexOf(" ");

  if (firstSpaceIndex === -1) {
    return null;
  }

  const commandName = line.slice(0, firstSpaceIndex);
  const completerPath = completionSpecs.get(commandName);

  if (completerPath === undefined) {
    return null;
  }

  const words = line.split(" ");
  const currentWord = words[words.length - 1];
  const previousWord = words.length >= 2 ? words[words.length - 2] : "";

  const result = spawnSync(completerPath, [commandName, currentWord, previousWord], {
    encoding: "utf8",
    env: {
      ...process.env,
      COMP_LINE: line,
      COMP_POINT: Buffer.byteLength(line, "utf8").toString(),
    },
  });

  if (result.error || result.status !== 0) {
    process.stdout.write("\x07");
    lastTabCompletionLine = null;
    return [[], currentWord];
  }

  const candidates = result.stdout
    .split(/\r?\n/)
    .filter((outputLine) => outputLine.length > 0)
    .sort();

  if (candidates.length === 0) {
    process.stdout.write("\x07");
    lastTabCompletionLine = null;
    return [[], currentWord];
  }

  if (candidates.length === 1) {
    lastTabCompletionLine = null;
    return [[`${candidates[0]} `], currentWord];
  }

  const commonPrefix = longestCommonPrefix(candidates);

  if (commonPrefix.length > currentWord.length) {
    lastTabCompletionLine = null;
    return [[commonPrefix], currentWord];
  }

  if (lastTabCompletionLine === line) {
    process.stdout.write(`\n${candidates.join("  ")}\n$ ${line}`);
    lastTabCompletionLine = null;
  } else {
    process.stdout.write("\x07");
    lastTabCompletionLine = line;
  }

  return [[], currentWord];
}

function completer(line: string): [string[], string] {
  const registeredCompletion = getRegisteredCompleterResult(line);

  if (registeredCompletion !== null) {
    return registeredCompletion;
  }

  const lastSpaceIndex = line.lastIndexOf(" ");

  // Complete arguments as files/directories.
  if (lastSpaceIndex !== -1) {
    const partialPath = line.slice(lastSpaceIndex + 1);
    const pathMatches = getPathMatches(partialPath);

    if (pathMatches.length === 0) {
      process.stdout.write("\x07");
      lastTabCompletionLine = null;
      return [[], partialPath];
    }

    if (pathMatches.length === 1) {
      lastTabCompletionLine = null;
      return [[pathMatches[0].completion], partialPath];
    }

    const commonPrefix = longestCommonPrefix(
      pathMatches.map((match) => match.lcpValue),
    );

    // Multiple matches, but they share more text than the user has typed.
    // Complete only to the LCP. Do not add "/" or " " yet.
    if (commonPrefix.length > partialPath.length) {
      lastTabCompletionLine = null;
      return [[commonPrefix], partialPath];
    }

    // Multiple matches and no extra common prefix:
    // first tab rings bell, second tab lists matches.
    if (lastTabCompletionLine === line) {
      const displayMatches = pathMatches.map((match) => match.display);

      process.stdout.write(`\n${displayMatches.join("  ")}\n$ ${line}`);
      lastTabCompletionLine = null;
    } else {
      process.stdout.write("\x07");
      lastTabCompletionLine = line;
    }

    return [[], partialPath];
  }

  const builtinMatches = autocompleteBuiltins.filter((builtin) =>
    builtin.startsWith(line),
  );

  const executableMatches = getExecutableMatches(line);

  const matches = [...new Set([...builtinMatches, ...executableMatches])].sort();

  if (matches.length === 0) {
    process.stdout.write("\x07");
    lastTabCompletionLine = null;
    return [[], line];
  }

  if (matches.length === 1) {
    lastTabCompletionLine = null;
    return [[`${matches[0]} `], line];
  }

  const commonPrefix = longestCommonPrefix(matches);

  if (commonPrefix.length > line.length) {
    lastTabCompletionLine = null;
    return [[commonPrefix], line];
  }

  if (lastTabCompletionLine === line) {
    process.stdout.write(`\n${matches.join("  ")}\n$ ${line}`);
    lastTabCompletionLine = null;
  } else {
    process.stdout.write("\x07");
    lastTabCompletionLine = line;
  }

  return [[], line];
}

function parseCommandLine(input: string): ShellToken[] {
  const tokens: ShellToken[] = [];

  let current = "";
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let currentWasQuoted = false;
  let buildingToken = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === "\\" && !inSingleQuotes && !inDoubleQuotes) {
      if (i + 1 < input.length) {
        current += input[i + 1];
        i++;
      } else {
        current += char;
      }

      buildingToken = true;
      currentWasQuoted = true;
      continue;
    }

    if (char === "\\" && inDoubleQuotes) {
      const nextChar = input[i + 1];

      if (nextChar === `"` || nextChar === "\\") {
        current += nextChar;
        i++;
      } else {
        current += char;
      }

      buildingToken = true;
      currentWasQuoted = true;
      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      currentWasQuoted = true;
      buildingToken = true;
      continue;
    }

    if (char === `"` && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      currentWasQuoted = true;
      buildingToken = true;
      continue;
    }

    if (!inSingleQuotes && !inDoubleQuotes && /\s/.test(char)) {
      if (buildingToken) {
        tokens.push({
          value: current,
          quoted: currentWasQuoted,
        });

        current = "";
        currentWasQuoted = false;
        buildingToken = false;
      }

      continue;
    }

    current += char;
    buildingToken = true;
  }

  if (buildingToken) {
    tokens.push({
      value: current,
      quoted: currentWasQuoted,
    });
  }

  return tokens;
}

function extractRedirections(tokens: ShellToken[]): ParsedCommand {
  const commandTokens: ShellToken[] = [];

  let stdoutTarget: RedirectTarget | null = null;
  let stderrTarget: RedirectTarget | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (!token.quoted && (token.value === ">>" || token.value === "1>>")) {
      stdoutTarget = {
        file: tokens[i + 1]?.value ?? "",
        append: true,
      };
      i++;
      continue;
    }

    if (!token.quoted && (token.value === ">" || token.value === "1>")) {
      stdoutTarget = {
        file: tokens[i + 1]?.value ?? "",
        append: false,
      };
      i++;
      continue;
    }

    if (!token.quoted && token.value === "2>>") {
      stderrTarget = {
        file: tokens[i + 1]?.value ?? "",
        append: true,
      };
      i++;
      continue;
    }

    if (!token.quoted && token.value === "2>") {
      stderrTarget = {
        file: tokens[i + 1]?.value ?? "",
        append: false,
      };
      i++;
      continue;
    }

    if (!token.quoted && token.value.startsWith("1>>") && token.value.length > 3) {
      stdoutTarget = {
        file: token.value.slice(3),
        append: true,
      };
      continue;
    }

    if (!token.quoted && token.value.startsWith("2>>") && token.value.length > 3) {
      stderrTarget = {
        file: token.value.slice(3),
        append: true,
      };
      continue;
    }

    if (!token.quoted && token.value.startsWith(">>") && token.value.length > 2) {
      stdoutTarget = {
        file: token.value.slice(2),
        append: true,
      };
      continue;
    }

    if (!token.quoted && token.value.startsWith("1>") && token.value.length > 2) {
      stdoutTarget = {
        file: token.value.slice(2),
        append: false,
      };
      continue;
    }

    if (!token.quoted && token.value.startsWith("2>") && token.value.length > 2) {
      stderrTarget = {
        file: token.value.slice(2),
        append: false,
      };
      continue;
    }

    if (!token.quoted && token.value.startsWith(">") && token.value.length > 1) {
      stdoutTarget = {
        file: token.value.slice(1),
        append: false,
      };
      continue;
    }

    commandTokens.push(token);
  }

  return {
    tokens: commandTokens,
    stdoutTarget,
    stderrTarget,
  };
}

function writeToRedirectOrStream(
  text: string,
  target: RedirectTarget | null,
  stream: NodeJS.WriteStream,
): void {
  if (target !== null) {
    writeFileSync(target.file, text, {
      flag: target.append ? "a" : "w",
    });
  } else {
    stream.write(text);
  }
}

function createRedirectFile(target: RedirectTarget | null): void {
  if (target === null) {
    return;
  }

  writeFileSync(target.file, "", {
    flag: target.append ? "a" : "w",
  });
}

function findExecutable(command: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const directories = pathEnv.split(path.delimiter);

  for (const directory of directories) {
    const fullPath = path.join(directory, command);

    try {
      accessSync(fullPath, constants.X_OK);
      return fullPath;
    } catch {
      // Not found or not executable, keep searching.
    }
  }

  return null;
}

function splitPipeline(input: string): [string, string] | null {
  let inSingleQuotes = false;
  let inDoubleQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === "\\" && !inSingleQuotes && !inDoubleQuotes) {
      i++;
      continue;
    }

    if (char === "\\" && inDoubleQuotes) {
      const nextChar = input[i + 1];

      if (nextChar === `"` || nextChar === "\\") {
        i++;
      }

      continue;
    }

    if (char === "'" && !inDoubleQuotes) {
      inSingleQuotes = !inSingleQuotes;
      continue;
    }

    if (char === `"` && !inSingleQuotes) {
      inDoubleQuotes = !inDoubleQuotes;
      continue;
    }

    if (char === "|" && !inSingleQuotes && !inDoubleQuotes) {
      const left = input.slice(0, i).trim();
      const right = input.slice(i + 1).trim();

      if (left.length === 0 || right.length === 0) {
        return null;
      }

      return [left, right];
    }
  }

  return null;
}

function waitForProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
}

function closeFdIfNeeded(fd: number | "inherit" | "pipe"): void {
  if (typeof fd === "number") {
    closeSync(fd);
  }
}

async function runPipeline(input: string): Promise<boolean> {
  const pipeline = splitPipeline(input);

  if (pipeline === null) {
    return false;
  }

  const leftParsed = extractRedirections(parseCommandLine(pipeline[0]));
  const rightParsed = extractRedirections(parseCommandLine(pipeline[1]));

  const leftCommand = leftParsed.tokens[0]?.value;
  const rightCommand = rightParsed.tokens[0]?.value;

  if (leftCommand === undefined || rightCommand === undefined) {
    createRedirectFile(leftParsed.stdoutTarget);
    createRedirectFile(leftParsed.stderrTarget);
    createRedirectFile(rightParsed.stdoutTarget);
    createRedirectFile(rightParsed.stderrTarget);
    return true;
  }

  const leftExecutablePath = findExecutable(leftCommand);

  if (leftExecutablePath === null) {
    writeToRedirectOrStream(
      `${leftCommand}: command not found\n`,
      leftParsed.stderrTarget,
      process.stderr,
    );
    return true;
  }

  const rightExecutablePath = findExecutable(rightCommand);

  if (rightExecutablePath === null) {
    writeToRedirectOrStream(
      `${rightCommand}: command not found\n`,
      rightParsed.stderrTarget,
      process.stderr,
    );
    return true;
  }

  const leftArgs = leftParsed.tokens.slice(1).map((token) => token.value);
  const rightArgs = rightParsed.tokens.slice(1).map((token) => token.value);

  const leftStderrFd =
    leftParsed.stderrTarget !== null
      ? openSync(leftParsed.stderrTarget.file, leftParsed.stderrTarget.append ? "a" : "w")
      : "inherit";

  const rightStdoutFd =
    rightParsed.stdoutTarget !== null
      ? openSync(rightParsed.stdoutTarget.file, rightParsed.stdoutTarget.append ? "a" : "w")
      : "inherit";

  const rightStderrFd =
    rightParsed.stderrTarget !== null
      ? openSync(rightParsed.stderrTarget.file, rightParsed.stderrTarget.append ? "a" : "w")
      : "inherit";

  let leftExited = false;
  let killTimer: NodeJS.Timeout | null = null;

  try {
    const leftProcess = spawn(leftExecutablePath, leftArgs, {
      stdio: ["inherit", "pipe", leftStderrFd],
      argv0: leftCommand,
    });

    const rightProcess = spawn(rightExecutablePath, rightArgs, {
      stdio: ["pipe", rightStdoutFd, rightStderrFd],
      argv0: rightCommand,
    });

    leftProcess.once("exit", () => {
      leftExited = true;
    });

    leftProcess.stdout?.on("error", () => {
      // The downstream command may close the pipe early, e.g. `head -n 5`.
    });

    rightProcess.stdin?.on("error", () => {
      // Ignore EPIPE-style errors when the downstream command exits first.
    });

    if (leftProcess.stdout !== null && rightProcess.stdin !== null) {
      leftProcess.stdout.pipe(rightProcess.stdin);
    }

    rightProcess.once("exit", () => {
      if (leftProcess.stdout !== null && rightProcess.stdin !== null) {
        leftProcess.stdout.unpipe(rightProcess.stdin);
        leftProcess.stdout.destroy();
      }

      // Required for commands like `tail -f file | head -n 5`: once `head`
      // has enough input and exits, the upstream `tail -f` must be stopped.
      if (!leftExited) {
        leftProcess.kill("SIGTERM");

        killTimer = setTimeout(() => {
          if (!leftExited) {
            leftProcess.kill("SIGKILL");
          }
        }, 250);

        killTimer.unref();
      }
    });

    await waitForProcess(rightProcess);
    await waitForProcess(leftProcess);
  } finally {
    if (killTimer !== null) {
      clearTimeout(killTimer);
    }

    closeFdIfNeeded(leftStderrFd);
    closeFdIfNeeded(rightStdoutFd);
    closeFdIfNeeded(rightStderrFd);
  }

  return true;
}

function refreshBackgroundJobStatuses(): void {
  for (const job of backgroundJobs) {
    if (job.status === "Done") {
      continue;
    }

    if (job.process.exitCode !== null) {
      job.status = "Done";
    }
  }
}

function getJobMarker(job: BackgroundJob, jobs: BackgroundJob[]): string {
  const currentJobNumber = jobs[jobs.length - 1]?.jobNumber;
  const previousJobNumber = jobs[jobs.length - 2]?.jobNumber;

  if (job.jobNumber === currentJobNumber) {
    return "+";
  }

  if (job.jobNumber === previousJobNumber) {
    return "-";
  }

  return " ";
}

function removeTrailingBackgroundMarker(command: string): string {
  return command.replace(/\s*&\s*$/, "");
}

function removeDoneBackgroundJobs(): void {
  for (let index = backgroundJobs.length - 1; index >= 0; index--) {
    if (backgroundJobs[index].status === "Done") {
      backgroundJobs.splice(index, 1);
    }
  }
}

function getNextAvailableJobNumber(): number {
  const usedJobNumbers = new Set(
    backgroundJobs.map((job) => job.jobNumber),
  );

  let jobNumber = 1;

  while (usedJobNumbers.has(jobNumber)) {
    jobNumber++;
  }

  return jobNumber;
}

function getJobsByJobNumber(): BackgroundJob[] {
  return [...backgroundJobs].sort((a, b) => a.jobNumber - b.jobNumber);
}

function reapDoneJobs(outputTarget: RedirectTarget | null = null): void {
  refreshBackgroundJobStatuses();

  for (const job of getJobsByJobNumber()) {
    if (job.status !== "Done") {
      continue;
    }

    const marker = getJobMarker(job, backgroundJobs);
    const statusField = "Done".padEnd(24, " ");

    writeToRedirectOrStream(
      `[${job.jobNumber}]${marker}  ${statusField}${removeTrailingBackgroundMarker(job.command)}\n`,
      outputTarget,
      process.stdout,
    );
  }

  removeDoneBackgroundJobs();
}

function promptWithReap(): void {
  reapDoneJobs();
  rl.prompt();
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
  completer,
});

promptWithReap();

rl.on("line", async (input: string) => {
  const handledAsPipeline = await runPipeline(input);

  if (handledAsPipeline) {
    promptWithReap();
    return;
  }

  const rawTokens = parseCommandLine(input);
  const parsed = extractRedirections(rawTokens);

  const tokens = parsed.tokens;
  const stdoutTarget = parsed.stdoutTarget;
  const stderrTarget = parsed.stderrTarget;

  if (tokens.length === 0) {
    createRedirectFile(stdoutTarget);
    createRedirectFile(stderrTarget);
    promptWithReap();
    return;
  }

  const runInBackground =
    tokens.length > 0 &&
    !tokens[tokens.length - 1].quoted &&
    tokens[tokens.length - 1].value === "&";

  if (runInBackground) {
    tokens.pop();
  }

  if (tokens.length === 0) {
    createRedirectFile(stdoutTarget);
    createRedirectFile(stderrTarget);
    promptWithReap();
    return;
  }

  const command = tokens[0].value;
  const argTokens = tokens.slice(1);
  const args = argTokens.map((token) => token.value);

  if (command === "exit") {
    rl.close();
    process.exit(0);
  }

  if (command === "echo") {
    createRedirectFile(stderrTarget);
    writeToRedirectOrStream(`${args.join(" ")}\n`, stdoutTarget, process.stdout);
    promptWithReap();
    return;
  }

  if (command === "pwd") {
    createRedirectFile(stderrTarget);
    writeToRedirectOrStream(`${process.cwd()}\n`, stdoutTarget, process.stdout);
    promptWithReap();
    return;
  }

  if (command === "cd") {
    createRedirectFile(stdoutTarget);

    const originalDirectory = argTokens[0]?.value;
    let directory = originalDirectory;

    if (directory === "~" && !argTokens[0]?.quoted) {
      directory = process.env.HOME ?? "";
    }

    try {
      process.chdir(directory ?? "");
      createRedirectFile(stderrTarget);
    } catch {
      writeToRedirectOrStream(
        `cd: ${originalDirectory}: No such file or directory\n`,
        stderrTarget,
        process.stderr,
      );
    }

    promptWithReap();
    return;
  }

  if (command === "jobs") {
    createRedirectFile(stderrTarget);

    refreshBackgroundJobStatuses();

    for (const job of getJobsByJobNumber()) {
      const marker = getJobMarker(job, backgroundJobs);
      const statusField = job.status.padEnd(24, " ");
      const displayedCommand =
        job.status === "Done"
          ? removeTrailingBackgroundMarker(job.command)
          : job.command;

      writeToRedirectOrStream(
        `[${job.jobNumber}]${marker}  ${statusField}${displayedCommand}\n`,
        stdoutTarget,
        process.stdout,
      );
    }

    removeDoneBackgroundJobs();
    rl.prompt();
    return;
  }

  if (command === "type") {
    createRedirectFile(stderrTarget);

    const commandToCheck = args[0] ?? "";

    if (builtins.has(commandToCheck)) {
      writeToRedirectOrStream(
        `${commandToCheck} is a shell builtin\n`,
        stdoutTarget,
        process.stdout,
      );
    } else {
      const executablePath = findExecutable(commandToCheck);

      if (executablePath !== null) {
        writeToRedirectOrStream(
          `${commandToCheck} is ${executablePath}\n`,
          stdoutTarget,
          process.stdout,
        );
      } else {
        writeToRedirectOrStream(
          `${commandToCheck}: not found\n`,
          stdoutTarget,
          process.stdout,
        );
      }
    }

    promptWithReap();
    return;
  }

  if (command === "complete") {
    if (args[0] === "-C") {
      const completerPath = args[1];
      const commandName = args[2];

      if (completerPath !== undefined && commandName !== undefined) {
        completionSpecs.set(commandName, completerPath);
      }

      createRedirectFile(stdoutTarget);
      createRedirectFile(stderrTarget);
      promptWithReap();
      return;
    }

    if (args[0] === "-p") {
      const commandName = args[1] ?? "";
      const completerPath = completionSpecs.get(commandName);

      if (completerPath !== undefined) {
        createRedirectFile(stderrTarget);

        writeToRedirectOrStream(
          `complete -C '${completerPath}' ${commandName}\n`,
          stdoutTarget,
          process.stdout,
        );
      } else {
        createRedirectFile(stdoutTarget);

        writeToRedirectOrStream(
          `complete: ${commandName}: no completion specification\n`,
          stderrTarget,
          process.stderr,
        );
      }

      promptWithReap();
      return;
    }

    if (args[0] === "-r") {
      const commandName = args[1];

      if (commandName !== undefined) {
        completionSpecs.delete(commandName);
      }

      createRedirectFile(stdoutTarget);
      createRedirectFile(stderrTarget);
      promptWithReap();
      return;
    }

    createRedirectFile(stdoutTarget);
    createRedirectFile(stderrTarget);
    promptWithReap();
    return;
  }

  const executablePath = findExecutable(command);

  if (executablePath !== null) {
    const stdoutFd =
      stdoutTarget !== null
        ? openSync(stdoutTarget.file, stdoutTarget.append ? "a" : "w")
        : "inherit";

    const stderrFd =
      stderrTarget !== null
        ? openSync(stderrTarget.file, stderrTarget.append ? "a" : "w")
        : "inherit";

    if (runInBackground) {
      const child = spawn(executablePath, args, {
        stdio: ["ignore", stdoutFd, stderrFd],
        argv0: command,
      });

      const jobNumber = getNextAvailableJobNumber();
      const backgroundJob: BackgroundJob = {
        jobNumber,
        pid: child.pid ?? 0,
        command: input.trim(),
        status: "Running",
        process: child,
      };

      backgroundJobs.push(backgroundJob);
      process.stdout.write(`[${jobNumber}] ${backgroundJob.pid}\n`);

      child.on("exit", (code) => {
        if (code !== null) {
          backgroundJob.status = "Done";
        }
      });

      child.on("close", () => {
        if (typeof stdoutFd === "number") {
          closeSync(stdoutFd);
        }

        if (typeof stderrFd === "number") {
          closeSync(stderrFd);
        }
      });

      child.unref();
      promptWithReap();
      return;
    }

    try {
      spawnSync(executablePath, args, {
        stdio: ["inherit", stdoutFd, stderrFd],
        argv0: command,
      });
    } finally {
      if (typeof stdoutFd === "number") {
        closeSync(stdoutFd);
      }

      if (typeof stderrFd === "number") {
        closeSync(stderrFd);
      }
    }

    promptWithReap();
    return;
  }

  createRedirectFile(stdoutTarget);
  writeToRedirectOrStream(
    `${command}: command not found\n`,
    stderrTarget,
    process.stderr,
  );
  promptWithReap();
});
