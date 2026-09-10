import "dotenv/config";
import { resolveProjectRoot } from "../agents/sandbox.js";
import { reindexRetrieval, retrievalStats } from "./index.js";

const root = resolveProjectRoot();
const stats = await reindexRetrieval(root);
console.log("indexed", stats, "into", await retrievalStats());
