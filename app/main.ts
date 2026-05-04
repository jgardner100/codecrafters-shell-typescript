import { createInterface } from "readline";

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

  console.log(`${command}: command not found`);
  rl.prompt();
});
