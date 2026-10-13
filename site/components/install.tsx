"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

const command = "npx ntwine";

// the launch command as a pill that copies itself
export function Install() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        // the check mark only once the copy lands: writing to the clipboard fails outside a secure context
        void navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="group inline-flex h-11 items-center gap-3 rounded-full border border-fd-border bg-fd-card pr-4 pl-5 font-mono text-sm transition-colors hover:border-[var(--gold)]"
      aria-label={`Copy "${command}"`}
    >
      <span className="text-fd-muted-foreground">$</span>
      {command}
      {copied ? (
        <Check className="size-4 text-[var(--gold)]" />
      ) : (
        <Copy className="size-4 text-fd-muted-foreground transition-colors group-hover:text-fd-foreground" />
      )}
    </button>
  );
}
