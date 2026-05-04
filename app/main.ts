import { createInterface } from "readline";
import { accessSync, constants } from "fs";
import path from "path";
import { spawnSync } from "child_process";

const builtins = new Set(["echo", "exit", "type"]);

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
  const trimmedInput = input.trim();

  if (trimmedInput === "exit") {
    rl.close();
    process.exit(0);
  }

  const [command, ...args] = trimmedInput.split(/\s+/);

  if (command === "echo") {
    console.log(args.join(" "));
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
