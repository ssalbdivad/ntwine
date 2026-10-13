import { cn } from "@/lib/cn";

// The nav's wordmark: the app icon beside the name, as the board's own header shows it.
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-tight", className)}>
      <img src="/img/tile.png" alt="" width={22} height={22} className="size-[22px] rounded-[22%]" />
      Ntwine
    </span>
  );
}
