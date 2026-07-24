import { z } from "zod";
import { memoryWireSchema } from "./schema.js";

/**
 * JSON Schema projection of the Memfile frontmatter contract.
 *
 * Published so the format can be implemented by anyone — the standard is
 * free to adopt; the verification loop is the product. Also used to
 * constrain structured output from distillation providers.
 */
export const memoryJsonSchema: Record<string, unknown> = z.toJSONSchema(
  memoryWireSchema,
  { io: "input", target: "draft-2020-12" },
);
