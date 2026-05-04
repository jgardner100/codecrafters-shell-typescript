import { createInterface } from "readline";

const builtins = new Set(["echo", "exit", "type"]);

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
      console.log(`${commandToCheck}: not found`);
    }

    rl.prompt();
    return;
  }

  console.log(`${command}: command not found`);
  rl.prompt();
});
