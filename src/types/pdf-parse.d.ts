declare module "pdf-parse" {
  export default function pdf(
    buffer: Buffer,
  ): Promise<{ text: string; numpages: number; info: Record<string, unknown> }>;
}
