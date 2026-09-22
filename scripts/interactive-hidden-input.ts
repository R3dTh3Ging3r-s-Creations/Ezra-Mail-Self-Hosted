export type HiddenInput = {
  isTTY?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  setEncoding: (encoding: BufferEncoding) => unknown;
  on: (event: "data", listener: (chunk: string | Buffer) => void) => unknown;
  off: (event: "data", listener: (chunk: string | Buffer) => void) => unknown;
};

export type HiddenOutput = {
  write(value: string): unknown;
};

export function readHidden(
  prompt: string,
  streams: { input: HiddenInput; output: HiddenOutput } = {
    input: process.stdin,
    output: process.stdout,
  },
): Promise<string> {
  const { input, output } = streams;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Run this recovery command from an interactive local or SSH terminal.");
  }
  output.write(prompt);
  input.setRawMode(true);
  input.setEncoding("utf8");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
    };

    const finish = (result: { value: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.write("\n");
      if ("error" in result) reject(result.error);
      else resolve(result.value);
    };

    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          finish({ value });
          return;
        }
        if (character === "\u0003") {
          finish({ error: new Error("Recovery cancelled.") });
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };

    input.on("data", onData);
    input.resume();
  });
}
