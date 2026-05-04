import { createInterface } from "readline";
import {
  accessSync,
  closeSync,
  constants,
  openSync,
  writeFileSync,
} from "fs";
import path from "path";
import { spawnSync } from "child_process";

const builtins = new Set(["echo", "exit", "type", "pwd", "cd"]);

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
  stderrFile: string | null;
};

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
  let stderrFile: string | null = null;

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

    if (!token.quoted && token.value === "2>") {
      stderrFile = tokens[i + 1]?.value ?? "";
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
      stderrFile = token.value.slice(2);
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
    stderrFile,
  };
}

function writeStdout(text: string, stdoutTarget: RedirectTarget | null): void {
  if (stdoutTarget !== null) {
    writeFileSync(stdoutTarget.file, text, {
      flag: stdoutTarget.append ? "a" : "w",
    });
  } else {
    process.stdout.write(text);
  }
}

function writeStderr(text: string, stderrFile: string | null): void {
  if (stderrFile !== null) {
    writeFileSync(stderrFile, text, { flag: "w" });
  } else {
    process.stderr.write(text);
  }
}

function createRedirectFile(stdoutTarget: RedirectTarget | null): void {
  if (stdoutTarget === null) {
    return;
  }

  writeFileSync(stdoutTarget.file, "", {
    flag: stdoutTarget.append ? "a" : "w",
  });
}

function createEmptyStderrFile(stderrFile: string | null): void {
  if (stderrFile !== null) {
    writeFileSync(stderrFile, "", { flag: "w" });
  }
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
      // File does not exist, or exists but is not executable.
      // Keep searching the rest of PATH.
    }
  }

  return null;
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

rl.prompt();

rl.on("line", (input: string) => {
  const rawTokens = parseCommandLine(input);
  const parsed = extractRedirections(rawTokens);

  const tokens = parsed.tokens;
  const stdoutTarget = parsed.stdoutTarget;
  const stderrFile = parsed.stderrFile;

  if (tokens.length === 0) {
    createEmptyRedirectFile(stdoutFile);
    createEmptyStderrFile(stderrFile);
    rl.prompt();
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
    createEmptyStderrFile(stderrFile);
    writeStdout(`${args.join(" ")}\n`, stdoutTarget);
    rl.prompt();
    return;
  }

  if (command === "pwd") {
    createEmptyStderrFile(stderrFile);
    writeStdout(`${process.cwd()}\n`, stdoutTarget);
    rl.prompt();
    return;
  }


  if (command === "cd") {
    createRedirectFile(stdoutTarget);

    const originalDirectory = argTokens[0]?.value;
    let directory = originalDirectory;

    if (directory === "~" && !argTokens[0]?.quoted) {
      directory = process.env.HOME;
    }

    try {
      process.chdir(directory ?? "");
      createEmptyStderrFile(stderrFile);
    } catch {
      writeStderr(
        `cd: ${originalDirectory}: No such file or directory\n`,
        stderrFile,
      );
    }

    rl.prompt();
    return;
  }

  if (command === "type") {
    createEmptyStderrFile(stderrFile);

    const commandToCheck = args[0] ?? "";

    if (builtins.has(commandToCheck)) {
      writeStdout(`${commandToCheck} is a shell builtin\n`, stdoutTarget);
    } else {
      const executablePath = findExecutable(commandToCheck);

      if (executablePath !== null) {
        writeStdout(`${commandToCheck} is ${executablePath}\n`, stdoutTarget);
      } else {
        writeStdout(`${commandToCheck}: not found\n`, stdoutTarget);
      }
    }

    rl.prompt();
    return;
  }

  const executablePath = findExecutable(command);

  if (executablePath !== null) {
    const stdoutFd =
      stdoutTarget !== null
        ? openSync(stdoutTarget.file, stdoutTarget.append ? "a" : "w")
        : "inherit";

    const stderrFd = stderrFile !== null ? openSync(stderrFile, "w") : "inherit";

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

    rl.prompt();
    return;
  }

  console.log(`${command}: command not found`);
  rl.prompt();
});
