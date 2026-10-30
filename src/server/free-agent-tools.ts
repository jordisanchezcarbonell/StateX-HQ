// Deliberately small workspace capability. This is not an OS sandbox.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";

export class FreeAgentError extends Error {
  constructor(public readonly code: string) { super(`free-agent: ${code}`); }
}
const MAX_FILE = 64 * 1024;
const field = z.string().min(1).max(1024);
const schemas = {
  Read: z.object({ file_path: field }).strict(),
  Write: z.object({ file_path: field, content: z.string().max(MAX_FILE) }).strict(),
  Edit: z.object({ file_path: field, old_string: z.string().min(1).max(MAX_FILE), new_string: z.string().max(MAX_FILE) }).strict(),
};
export type FileTool = keyof typeof schemas;
export const FREE_TOOLS = Object.entries(schemas).map(([name, schema]) => ({
  type: "function", function: { name, description: name === "Read" ? "Read a UTF-8 workspace file using a relative path." : name === "Edit" ? "Replace exactly one occurrence in the current contents of a previously read file. After any successful mutation, read the file again before another mutation. Requires user approval." : "Write a UTF-8 file using a relative path. Read existing files first; after any successful mutation, read the file again before another mutation. Requires user approval.", parameters: z.toJSONSchema(schema) },
}));
const blocked = (part: string) => /^(\.git|\.claude|\.pixel-office|\.ssh|\.aws|\.codex|node_modules|\.env(?:\..*)?|secrets(?:\..*)?|credentials(?:\..*)?)$/i.test(part);
function fail(code: string): never { throw new FreeAgentError(code); }
const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
export class WorkspaceTools {
  private root: string;
  private reads = new Map<string, string>();
  constructor(private cwd: string) { this.root = fs.realpathSync(cwd); }
  private resolve(name: string): string {
    if (!name || path.isAbsolute(name) || name.includes("\\") || /[\x00-\x1f\x7f]/.test(name) || name.split("/").some(p => !p || p === "." || p === ".." || blocked(p))) fail("path_forbidden");
    if (fs.realpathSync(this.cwd) !== this.root) fail("workspace_changed");
    const parts = name.split("/");
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      try {
        const st = fs.lstatSync(current);
        if (st.isSymbolicLink() || (i < parts.length - 1 && !st.isDirectory())) fail("path_forbidden");
        const real = fs.realpathSync(current);
        if (real !== current || !real.startsWith(this.root + path.sep)) fail("path_forbidden");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && i === parts.length - 1) return current;
        throw err;
      }
    }
    return current;
  }
  private contents(file: string): string | undefined {
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > MAX_FILE) fail("file_forbidden");
      const bytes = Buffer.alloc(MAX_FILE + 1);
      const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
      if (length > MAX_FILE) fail("file_too_large");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      if (text.includes("\0")) fail("text_only");
      return text;
    } finally { fs.closeSync(fd); }
  }
  async execute(name: string, input: unknown, signal: AbortSignal,
    approve: (tool: FileTool, input: Record<string, unknown>) => Promise<boolean>, readOnly = false): Promise<string> {
    try {
      signal.throwIfAborted();
      if (!Object.hasOwn(schemas, name)) fail("tool_forbidden");
      const parsed = schemas[name as FileTool].safeParse(input);
      if (!parsed.success) fail("invalid_tool_arguments");
      const args = parsed.data;
      const file = this.resolve(args.file_path);
      const before = this.contents(file);
      if (name === "Read") {
        if (before === undefined) fail("file_not_found");
        this.reads.set(file, hash(before));
        return before;
      }
      if (readOnly) fail("read_only");
      // The authorisation list for intel tools is the boss's file: agents may read it, never change it.
      // Case-insensitive, as on APFS "SCOPE.JSON" is the same file (or creates one loadScope will read).
      if (path.dirname(file) === this.root && path.basename(file).toLowerCase() === "scope.json") fail("path_forbidden");
      if (before !== undefined && this.reads.get(file) !== hash(before)) fail("read_before_write_required");
      let after: string;
      if (name === "Edit") {
        const edit = schemas.Edit.parse(input);
        if (before === undefined || !before.includes(edit.old_string) || before.indexOf(edit.old_string) !== before.lastIndexOf(edit.old_string)) fail("edit_requires_unique_match");
        after = before.replace(edit.old_string, () => edit.new_string);
      } else after = schemas.Write.parse(input).content;
      if (Buffer.byteLength(after) > MAX_FILE || after.includes("\0")) fail("file_too_large");
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new FreeAgentError("cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
      });
      let allowed: boolean;
      try { allowed = await Promise.race([approve(name as FileTool, { ...args }), cancelled]); }
      finally { signal.removeEventListener("abort", onAbort); }
      if (!allowed) return "Error: user_denied";
      signal.throwIfAborted();
      // Approval is for these exact bytes, never for a path or file changed while waiting.
      if (this.resolve(args.file_path) !== file || this.contents(file) !== before) fail("file_changed_since_approval");
      // Synchronous check/commit: no other agent JS can swap a path between them.
      // Atomic replacement avoids following a target symlink and modifying hardlink aliases.
      const tmp = path.join(path.dirname(file), `.statex-${crypto.randomUUID()}.tmp`);
      let created = false;
      try {
        fs.writeFileSync(tmp, after, { flag: "wx", mode: 0o600 }); created = true;
        if (this.resolve(args.file_path) !== file || this.contents(file) !== before) fail("file_changed_since_approval");
        fs.renameSync(tmp, file); created = false;
      } finally { if (created) fs.unlinkSync(tmp); }
      this.reads.delete(file);
      return "OK: file written; Read it again to verify.";
    } catch (err) {
      if (signal.aborted) throw new FreeAgentError("cancelled");
      if (err instanceof FreeAgentError) throw err;
      // Never reflect OS paths, file contents or arbitrary exception messages.
      throw new FreeAgentError("file_operation_failed");
    }
  }
}
