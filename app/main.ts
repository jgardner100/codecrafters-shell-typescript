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

function parseCommandLine(input: string): ShellToken[] {
  const tokens: ShellToken[] = [];

  let current = "";
  let inSingleQuotes = false;
  let inDoubleQuotes = false;
  let currentWasQuoted = false;
  let buildingToken = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    // Backslash outside quotes: escape any next character.
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

    // Backslash inside double quotes: only \" and \\ are special here.
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

function extractStdoutRedirection(tokens: ShellToken[]): ParsedCommand {
  const commandTokens: ShellToken[] = [];
  let stdoutFile: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (!token.quoted && (token.value === ">" || token.value === "1>")) {
      stdoutFile = tokens[i + 1]?.value ?? null;
      i++;
      continue;
    }

    if (!token.quoted && token.value.startsWith("1>") && token.value.length > 2) {
      stdoutFile = token.value.slice(2);
      continue;
    }

    if (!token.quoted && token.value.startsWith(">") && token.value.length > 1) {
      stdoutFile = token.value.slice(1);
      continue;
    }

    commandTokens.push(token);
  }

  return {
    tokens: commandTokens,
    stdoutFile,
  };
}

function writeStdout(text: string, stdoutFile: string | null): void {
  if (stdoutFile !== null) {
    writeFileSync(stdoutFile, text, { flag: "w" });
  } else {
    process.stdout.write(text);
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
  const parsed = extractStdoutRedirection(rawTokens);
  const tokens = parsed.tokens;
  const stdoutFile = parsed.stdoutFile;

  if (tokens.length === 0) {
    if (stdoutFile !== null) {
      writeFileSync(stdoutFile, "", { flag: "w" });
    }

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
    writeStdout(`${args.join(" ")}\n`, stdoutFile);
    rl.prompt();
    return;
  }

  if (command === "pwd") {
    writeStdout(`${process.cwd()}\n`, stdoutFile);
    rl.prompt();
    return;
  }

  if (command === "cd") {
    const originalDirectory = argTokens[0]?.value;
    let directory = originalDirectory;

    if (directory === "~" && !argTokens[0]?.quoted) {
      directory = process.env.HOME;
    }

    try {
      process.chdir(directory ?? "");
    } catch {
      console.log(`cd: ${originalDirectory}: No such file or directory`);
    }

    rl.prompt();
    return;
  }

  if (command === "type") {
    const commandToCheck = args[0];

    if (builtins.has(commandToCheck)) {
      writeStdout(`${commandToCheck} is a shell builtin\n`, stdoutFile);
    } else {
      const executablePath = findExecutable(commandToCheck);

      if (executablePath !== null) {
        console.log(`${commandToCheck} is ${executablePath}`);
      } else {
        console.log(`${commandToCheck}: not found`);
      }
    }

    rl.prompt();
    return;
  }

  const executablePath = findExecutable(command);

  if (executablePath !== null) {
    if (stdoutFile !== null) {
      const fd = openSync(stdoutFile, "w");

      try {
        spawnSync(executablePath, args, {
          stdio: ["inherit", fd, "inherit"],
          argv0: command,
        });
      } finally {
        closeSync(fd);
      }
    } else {
      spawnSync(executablePath, args, {
        stdio: "inherit",
        argv0: command,
      });
    }

    rl.prompt();
    return;
  }

  console.log(`${command}: command not found`);
  rl.prompt();
});
