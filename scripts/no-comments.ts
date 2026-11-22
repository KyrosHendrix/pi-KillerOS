import path from "node:path";
import { fileURLToPath } from "node:url";
import exceptions from "./no-comments.allowlist.json" with { type: "json" };

type SourcePosition = { line: number; column: number };
type SourceLocation = { start: SourcePosition; end: SourcePosition };
type ParsedComment = { loc: SourceLocation };
type CommentRuleContext = {
  filename: string;
  sourceCode: {
    getAllComments(): readonly ParsedComment[];
    getText(comment: ParsedComment): string;
  };
  report(diagnostic: { loc: SourceLocation; message: string }): void;
};

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const exceptionsByFile = new Map<string, readonly string[]>(
  Object.entries(exceptions),
);

export default {
  meta: { name: "killeros" },
  rules: {
    "no-comments": {
      meta: { schema: [] },
      create(context: CommentRuleContext) {
        return {
          Program() {
            const file = path
              .relative(repositoryRoot, context.filename)
              .replaceAll("\\", "/");
            const remaining = exceptionsByFile.get(file)?.slice() ?? [];
            const { sourceCode } = context;
            for (const comment of sourceCode.getAllComments()) {
              const text = sourceCode.getText(comment).replaceAll("\r\n", "\n");
              const exception = remaining.indexOf(text);
              if (exception !== -1) {
                remaining.splice(exception, 1);
                continue;
              }
              context.report({
                loc: comment.loc,
                message: "Remove this source comment.",
              });
            }
            if (remaining.length > 0) {
              context.report({
                loc: {
                  start: { line: 1, column: 0 },
                  end: { line: 1, column: 0 },
                },
                message: `Remove ${remaining.length} unused comment exception(s) for ${file} from scripts/no-comments.allowlist.json.`,
              });
            }
          },
        };
      },
    },
  },
};
