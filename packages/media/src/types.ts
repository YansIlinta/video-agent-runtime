import type { z } from "zod";
import { mediaMetadataSchema } from "../../core/src/index.js";

export type MediaMetadata = z.infer<typeof mediaMetadataSchema>;
