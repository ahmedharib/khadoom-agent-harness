import { z } from "zod";

export const JsonPatchOperationSchema = z.object({
  op: z.enum([
    "add",
    "remove",
    "replace",
    "move",
    "copy",
    "test",
    "increment",
    "decrement",
    "percentage",
    "multiply",
  ]),
  path: z.string().startsWith("/", { message: "JSON Patch path must start with '/'" }),
  value: z.any().optional(),
  from: z.string().optional(),
});

export const MutationPlanSchema = z.object({
  explanation: z.string().describe("Clear, user-facing summary of what changes are being proposed and why"),
  patches: z.array(JsonPatchOperationSchema).min(1, "Must contain at least one patch operation"),
});

export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;
export type MutationPlan = z.infer<typeof MutationPlanSchema>;
