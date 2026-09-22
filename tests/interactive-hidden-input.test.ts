import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { readHidden } from "../scripts/interactive-hidden-input";

class FakeTtyInput extends PassThrough {
  isTTY = true;
  rawModes: boolean[] = [];

  setRawMode(enabled: boolean) {
    this.rawModes.push(enabled);
    return this;
  }

  resume() {
    return this;
  }

  pause() {
    return this;
  }

  setEncoding() {
    return this;
  }
}

class FakeOutput {
  chunks: string[] = [];

  write(value: string) {
    this.chunks.push(value);
    return true;
  }
}

describe("interactive hidden input", () => {
  it("supports two sequential password reads without aborting the terminal stream", async () => {
    const input = new FakeTtyInput();
    const output = new FakeOutput();

    const first = readHidden("New owner password: ", { input, output });
    input.emit("data", "first-secret\r");
    await expect(first).resolves.toBe("first-secret");

    const second = readHidden("Confirm new password: ", { input, output });
    input.emit("data", "second-secret\r");
    await expect(second).resolves.toBe("second-secret");

    expect(input.rawModes).toEqual([true, false, true, false]);
    expect(output.chunks.join("")).toBe(
      "New owner password: \nConfirm new password: \n",
    );
  });

  it("restores terminal mode when the owner cancels", async () => {
    const input = new FakeTtyInput();
    const output = new FakeOutput();

    const password = readHidden("New owner password: ", { input, output });
    input.emit("data", "partial\u0003");

    await expect(password).rejects.toThrow("Recovery cancelled.");
    expect(input.rawModes).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
  });
});
