import { z } from "zod";

export const cpusSchema = z.number().positive().max(1024).multipleOf(0.01);
export const cpuSharesSchema = z.number().int().min(2).max(262144);
export const memorySchema = z.string().regex(/^[1-9][0-9]{0,6}[mg]$/);
export const writerLimitsSchema = z.object({
  cpus: cpusSchema.optional(),
  cpuShares: cpuSharesSchema.optional(),
  memory: memorySchema.optional(),
}).strict();
export type WriterLimits = z.infer<typeof writerLimitsSchema>;

/** Omitted settings remove previous limits; never persist an empty limits object. */
export function writerLimits(settings: WriterLimits): WriterLimits | undefined {
  const { cpus, cpuShares, memory } = settings;
  if (cpus === undefined && cpuShares === undefined && memory === undefined) return undefined;
  return { ...(cpus === undefined ? {} : { cpus }), ...(cpuShares === undefined ? {} : { cpuShares }), ...(memory === undefined ? {} : { memory }) };
}
export function sameWriterLimits(left: WriterLimits | undefined, right: WriterLimits | undefined): boolean {
  return left?.cpus === right?.cpus && left?.cpuShares === right?.cpuShares && left?.memory === right?.memory;
}
