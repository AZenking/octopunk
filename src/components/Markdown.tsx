// Markdown renderer for child-agent output — Codex-equivalent stack:
// micromark parse (react-markdown) + shiki TextMate highlighting.
// The highlighter is a lazily-created singleton with an LRU-ish cache;
// blocks render as plain code until their highlighted HTML arrives.

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createHighlighter, type Highlighter } from "shiki";
import { readCodeTheme, subscribeCodeTheme, type CodeTheme } from "@/lib/codeTheme";
import { cn } from "@/lib/utils";

const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "bash",
  "shell",
  "python",
  "rust",
  "go",
  "css",
  "html",
  "markdown",
  "yaml",
  "sql",
  "java",
  "kotlin",
  "swift",
  "c",
  "cpp",
  "diff",
  "toml",
] as const;

const highlighterPromises = new Map<string, Promise<Highlighter>>();

function getHighlighter(theme: CodeTheme): Promise<Highlighter> {
  let promise = highlighterPromises.get(theme.id);
  if (promise == null) {
    promise = createHighlighter({
      themes: [theme.light, theme.dark],
      langs: [...LANGS],
    });
    highlighterPromises.set(theme.id, promise);
  }
  return promise;
}

const htmlCache = new Map<string, string>();

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [theme, setTheme] = useState<CodeTheme>(() => readCodeTheme());

  useEffect(
    () =>
      subscribeCodeTheme((id) => {
        const next = readCodeTheme();
        if (next.id === id) setTheme(next);
      }),
    [],
  );

  const key = theme.id + "\u0000" + language + "\u0000" + code;
  const [html, setHtml] = useState<string | null>(() => htmlCache.get(key) ?? null);

  useEffect(() => {
    let cancelled = false;
    if (htmlCache.has(key)) {
      setHtml(htmlCache.get(key) ?? null);
      return;
    }
    void (async () => {
      try {
        const highlighter = await getHighlighter(theme);
        const loaded = highlighter.getLoadedLanguages();
        const rendered = highlighter.codeToHtml(code, {
          lang: loaded.includes(language) ? language : "text",
          themes: { light: theme.light, dark: theme.dark },
          defaultColor: false,
        });
        if (htmlCache.size > 200) htmlCache.clear();
        htmlCache.set(key, rendered);
        if (!cancelled) setHtml(rendered);
      } catch {
        // Keep the plain fallback on failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, language, theme]);

  if (html != null) {
    return <div dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <pre className="font-mono text-xs whitespace-pre-wrap">
      <code>{code}</code>
    </pre>
  );
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (node != null && typeof node === "object" && "props" in node) {
    return extractText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose dark:prose-invert prose-sm max-w-none",
        "prose-headings:mb-1 prose-headings:mt-3 prose-headings:font-semibold",
        "prose-p:my-1.5 prose-li:my-0.5",
        "prose-code:rounded prose-code:bg-secondary/70 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:bg-muted/50 prose-pre:border-border prose-pre:rounded-lg prose-pre:border prose-pre:py-3 prose-pre:font-mono prose-pre:text-xs",
        "prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1",
        "prose-blockquote:border-l-primary/40",
        "prose-a:text-primary",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Fenced blocks render themselves; the wrapper <pre> would nest.
          pre: ({ children }) => <>{children}</>,
          code: ({ className: codeClassName, children }) => {
            const language = /language-(\w+)/.exec(codeClassName ?? "")?.[1] ?? "";
            if (language.length === 0) {
              return <code className={codeClassName}>{children}</code>;
            }
            return <CodeBlock code={extractText(children).replace(/\n$/, "")} language={language} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
