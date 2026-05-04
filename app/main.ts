import { createInterface } from "readline";
import { accessSync, constants } from "fs";
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
  let currentWasQuoted = false;
  let buildingToken = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === "'") {
      inSingleQuotes = !inSingleQuotes;
      currentWasQuoted = true;
      buildingToken = true;
      continue;
    }

    if (!inSingleQuotes && /\s/.test(char)) {
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
  const tokens = parseCommandLine(input);

  if (tokens.length === 0) {
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
    console.log(args.join(" "));
    rl.prompt();
    return;
  }

  if (command === "pwd") {
    console.log(process.cwd());
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
      console.log(`${commandToCheck} is a shell builtin`);
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
    spawnSync(executablePath, args, {
      stdio: "inherit",
      argv0: command,
    });

    rl.prompt();
    return;
  }

  console.log(`${command}: command not found`);
  rl.prompt();
});
