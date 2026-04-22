import type { Context } from "hono";
import type { Env } from "./bindings";

export type AppContext = Context<{ Bindings: Env }>;
export type HandleArgs = [AppContext];
