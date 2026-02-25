const path = require("path");
const { spawnSync } = require("child_process");

function normalizeOutputPath(outputPath) {
  if (!outputPath || path.isAbsolute(outputPath)) {
    return outputPath;
  }

  const normalized = outputPath.replace(/\\/g, "/");
  if (normalized.startsWith("test-results/")) {
    return outputPath;
  }

  return path.join("test-results", outputPath);
}

function normalizeArgs(args) {
  const updatedArgs = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    if (current === "--output") {
      const nextValue = args[index + 1];
      if (typeof nextValue === "string" && nextValue.length > 0) {
        updatedArgs.push("--output", normalizeOutputPath(nextValue));
        index += 1;
      } else {
        updatedArgs.push(current);
      }
      continue;
    }

    if (current === "-o") {
      const nextValue = args[index + 1];
      if (typeof nextValue === "string" && nextValue.length > 0) {
        updatedArgs.push("-o", normalizeOutputPath(nextValue));
        index += 1;
      } else {
        updatedArgs.push(current);
      }
      continue;
    }

    if (current.startsWith("--output=")) {
      const value = current.slice("--output=".length);
      updatedArgs.push(`--output=${normalizeOutputPath(value)}`);
      continue;
    }

    updatedArgs.push(current);
  }

  return updatedArgs;
}

function run() {
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const incomingArgs = process.argv.slice(2);
  const hasOutputFlag = incomingArgs.some((arg, i) => arg === "--output" || (typeof arg === "string" && arg.startsWith("--output=")) || (arg === "-o" && typeof incomingArgs[i + 1] === "string"));
  const normalizedArgs = normalizeArgs(incomingArgs);

  if (hasOutputFlag) {
    const joined = normalizedArgs.join(" ");
    console.log(`[safe-e2e] Using normalized output args: ${joined}`);
  }

  const result = spawnSync(npxCommand, ["playwright", "test", ...normalizedArgs], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error("Error in SafePlaywrightRunner:", result.error);
    process.exit(1);
  }

  process.exit(result.status === null ? 1 : result.status);
}

run();