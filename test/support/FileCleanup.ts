import { rmSync } from "node:fs";

export async function removeDirectoryEventually(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || !["EPERM", "EBUSY"].includes(String(error.code))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  rmSync(directory, { recursive: true, force: true });
}
