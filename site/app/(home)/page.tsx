import {
  AlarmClock,
  ArrowRight,
  AtSign,
  Code2,
  GitPullRequest,
  GitFork,
  Repeat,
  SquareTerminal,
  Target,
  Timer,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Install } from "@/components/install";
import { Mark } from "@/components/mark";
import { Shot } from "@/components/shot";
import { githubUrl } from "@/lib/layout.shared";

// every card names one thing Frizz does, in a line, and links to the page that says the rest
const features = [
  { icon: AlarmClock, title: "Snooze", text: "Park a card until tomorrow, with what to do when it wakes.", href: "/docs/snooze" },
  { icon: Target, title: "Goals", text: "“Keep going until CI is green”, re-sent at every rest.", href: "/docs/goals" },
  { icon: Repeat, title: "Schedules", text: "“Every weekday at 9am” starts a fresh thread each time.", href: "/docs/schedules" },
  { icon: Timer, title: "Time limits", text: "“2h”, and the agent plans the best result by then.", href: "/docs/time-limits" },
  { icon: AtSign, title: "Handles", text: "Threads read and message each other by @handle.", href: "/docs/handles" },
  { icon: GitFork, title: "Spinoff", text: "A new thread from any card, carrying its context.", href: "/docs/handles#spinoff" },
  { icon: SquareTerminal, title: "Terminals", text: "A shell in the folder the agent works in, on t.", href: "/docs/terminals" },
  { icon: GitPullRequest, title: "GitHub", text: "Issues into threads, and watchers that wake on CI.", href: "/docs/github" },
  { icon: Code2, title: "Your editor", text: "A VS Code sidebar that sends your selection along.", href: "/docs/editor" },
];

// the commitments every feature is held to, one line each; /docs/principles says the rest
const principles = [
  { title: "The agent decides.", text: "A thread's state is its agent's own last word. Frizz only checks that it holds up." },
  { title: "Frizz never answers for it.", text: "Nothing is answered, parked or withdrawn on an agent's behalf, outside a short, listed set." },
  { title: "Every card is yours to act on.", text: "Nothing enters the queue just to be dismissed, and a running thread never does." },
  { title: "Five bands, never lost.", text: "Pinned, Queue, Running, Snoozed, Done. Every thread is in exactly one." },
  { title: "One project at a time.", text: "A project's board is the default. All projects is one click away." },
  { title: "Nothing of its own.", text: "No model, no cloud, no workflow: your CLIs on your sign-in, on localhost." },
];

const agents = ["Claude Code", "Codex", "OpenCode", "Gemini CLI", "Copilot CLI", "Cursor", "goose", "Qwen Code"];

// a watch outliving the session that set it: the thread rests out of the queue, and each event wakes it
const watchFeed = `  @settings-store  resting · watching acme/api#391

  Tue 14:02   CI passed
  Thu 09:41   review requested
  Thu 11:17   2 review comments
              ↳ @settings-store wakes and answers them

  @parser-review   waiting on @settings-store
              ↳ wakes when it hands back`;

const remoteMenu = `  Reach this board from anywhere

  ❯ Private name        no account, nothing to install
    Cloudflare Tunnel   a domain you own
    Tailscale           your tailnet
    Something else      any proxy you run
    Off                 loopback only`;

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-6xl px-6">
      <section className="grid items-center gap-12 pt-16 pb-20 md:grid-cols-[1fr_1.35fr] md:pt-24">
        <div>
          <h1 className="sr-only">Frizz</h1>
          <Mark className="h-auto w-24 md:w-28" />
          <p className="mt-8 text-3xl leading-tight font-semibold tracking-tight text-balance md:text-4xl">
            An opinionated agent console for extreme productivity.
          </p>
          <p className="mt-4 text-lg text-fd-muted-foreground text-balance">
            Run Claude Code, Codex and any ACP agent from one browser tab. Every agent that needs you becomes a card
            in one queue.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/docs/quick-start"
              className="inline-flex h-11 items-center gap-2 rounded-full bg-fd-primary px-5 font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Get started <ArrowRight className="size-4" />
            </Link>
            <Install />
          </div>
        </div>
        <Shot
          src="/img/board.png"
          width={1760}
          height={1100}
          priority
          alt="Frizz focused on one project: the prompt box and the project's threads on the left, and on the right the first queue card, where an agent asks whether the settings store should use SQLite or a JSON file, with lettered options and a countdown to the recommended pick."
        />
      </section>

      <section className="pb-16">
        <p className="text-center text-sm text-fd-muted-foreground">Drives the agents you already use</p>
        <ul className="mt-4 flex flex-wrap justify-center gap-x-8 gap-y-2 font-mono text-sm text-fd-foreground/80">
          {agents.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </section>

      <section className="py-16">
        <Heading title="Principles." subtitle="What every feature is held to." />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {principles.map(({ title, text }) => (
            <div key={title} className="rounded-2xl border border-dashed border-fd-border p-5">
              <span className="font-semibold">{title}</span>
              <p className="mt-1 text-sm text-fd-muted-foreground">{text}</p>
            </div>
          ))}
        </div>
        <More href="/docs/principles">All the principles</More>
      </section>

      <Split
        title="One queue, not ten terminals."
        link={{ href: "/docs/queue", text: "How the queue works" }}
        media={
          <Shot
            src="/img/question.png"
            width={1600}
            height={558}
            alt="A question card asking whether the settings store should use SQLite or a JSON file, with option A marked recommended, a row for typing something else, and below it a countdown to the recommended pick."
          />
        }
      >
        <p>
          A worker runs until it reaches something only you can settle, then hands back a question with lettered
          options and its own recommendation. One keystroke answers it.
        </p>
        <p>
          Threads waiting on their own sub-agents, on CI or on a review stay out of the queue, so nothing shows up just
          to be dismissed. A question you leave alone takes the recommended option after ten minutes.
        </p>
      </Split>

      <section className="grid gap-10 py-16 md:grid-cols-[1fr_1.1fr] md:items-center">
        <div>
          <Heading title="Waits that outlive the agent." />
          <div className="mt-5 space-y-4 text-lg text-fd-muted-foreground">
            <p>
              An agent waiting on CI, a review, a reporter&rsquo;s reply or another thread registers a watch and rests,
              out of your queue. Frizz holds the watch, not the agent&rsquo;s session, so it lasts as long as the
              server: days, or years.
            </p>
            <p>
              When something lands, the thread wakes and answers it on its own. Every thread has an{" "}
              <Code>@handle</Code>, so agents read, message and wait on each other the same way.
            </p>
          </div>
          <More href="/docs/github#watchers">Watchers</More>
        </div>
        <div className="overflow-hidden rounded-2xl border border-fd-border bg-fd-card shadow-xl shadow-black/10">
          <div className="flex items-center gap-2 border-b border-fd-border px-4 py-3">
            <span className="size-3 rounded-full bg-fd-border" />
            <span className="size-3 rounded-full bg-fd-border" />
            <span className="size-3 rounded-full bg-[var(--gold)]" />
            <span className="ml-2 font-mono text-xs text-fd-muted-foreground">acme-api</span>
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-[0.8rem] leading-relaxed">{watchFeed}</pre>
        </div>
      </section>

      <Split
        title="One server, every project."
        flip
        link={{ href: "/docs/projects", text: "Projects" }}
        media={
          <Shot
            src="/img/projects.png"
            width={1760}
            height={1100}
            alt="The All projects page: billing-worker, marketing-site and acme-api each list their threads on the left, and the cards from every project are queued on the right."
          />
        }
      >
        <p>
          One server serves every repo on your machine, and each gets its own board. Run <Code>npx frizz</Code> in a
          second one and it joins. All projects shows every board&rsquo;s work at once, one click away.
        </p>
        <p>
          Each agent runs in its own background process. Close the tab or stop Frizz, and it keeps working; relaunch,
          and Frizz reconnects.
        </p>
      </Split>

      <section className="py-16">
        <Heading title="Built for the long run." subtitle="The parts that let a thread work without you." />
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, text, href }) => (
            <Link
              key={title}
              href={href}
              className="group flex flex-col rounded-2xl border border-fd-border bg-fd-card p-5 transition-colors hover:border-[var(--gold)]"
            >
              <Icon className="size-5 text-[var(--gold)]" />
              <span className="mt-3 font-semibold">{title}</span>
              <span className="mt-1 text-sm text-fd-muted-foreground">{text}</span>
            </Link>
          ))}
        </div>
      </section>

      <Split
        title="Schedules, in plain words."
        link={{ href: "/docs/schedules", text: "Schedules" }}
        media={
          <Shot src="/img/schedule.png" width={1598} height={639} alt="The prompt box reading 'every weekday at 9am triage new issues' as a schedule: the phrase highlighted, the send button turned into a repeat button, and a strip reading 'Every weekday at 9am · next Thu Oct 8, in 22h'." />
        }
      >
        <p>
          Type &ldquo;every weekday at 9am triage new issues&rdquo; and the prompt box reads the schedule as you type,
          showing when it next runs. Each run starts a fresh thread that lands in the queue like any other.
        </p>
      </Split>

      <Split
        title="Go until 3:30."
        flip
        link={{ href: "/docs/time-limits", text: "Time limits" }}
        media={
          <Shot src="/img/time-limit.png" width={1600} height={688} alt="A queue card whose header shows a 43m left countdown, with the time-limit panel open: +15m, +30m and +1h, a field for a new limit, and Remove time limit." />
        }
      >
        <p>
          Give a thread &ldquo;2h&rdquo; or &ldquo;15:30&rdquo;. The agent plans for the best result it can hand over
          by then, gets reminders as time runs out, and passes a share of it to its sub-agents. The card counts down.
        </p>
      </Split>

      <section className="grid gap-10 py-16 md:grid-cols-[1fr_1.1fr] md:items-center">
        <div>
          <Heading title="From your phone, too." />
          <div className="mt-5 space-y-4 text-lg text-fd-muted-foreground">
            <p>
              Press <Code>R</Code> in the terminal running Frizz and pick how a phone reaches it. A private frizz.sh
              name needs no account and nothing installed.
            </p>
            <p>
              Frizz stays on localhost either way, and the first visit from each device needs a single-use sign-in
              link, shown as a QR code.
            </p>
          </div>
          <More href="/docs/remote-access">Remote access</More>
        </div>
        <div className="overflow-hidden rounded-2xl border border-fd-border bg-fd-card shadow-xl shadow-black/10">
          <div className="flex items-center gap-2 border-b border-fd-border px-4 py-3">
            <span className="size-3 rounded-full bg-fd-border" />
            <span className="size-3 rounded-full bg-fd-border" />
            <span className="size-3 rounded-full bg-[var(--gold)]" />
            <span className="ml-2 font-mono text-xs text-fd-muted-foreground">npx frizz</span>
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-[0.8rem] leading-relaxed">{remoteMenu}</pre>
        </div>
      </section>


      <section className="flex flex-col items-center py-24 text-center">
        <p className="text-lg text-fd-muted-foreground">Ready to clear your queue?</p>
        <div className="mt-6">
          <Install />
        </div>
        <Link href="/docs/quick-start" className="mt-6 inline-flex items-center gap-2 font-medium text-[var(--gold)] hover:underline">
          Read the quick start <ArrowRight className="size-4" />
        </Link>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-fd-border py-8 text-sm text-fd-muted-foreground">
        <span>
          MIT licensed. By{" "}
          <a href="https://x.com/colinhacks" className="hover:text-fd-foreground">
            @colinhacks
          </a>
          .
        </span>
        <span className="flex gap-5">
          <Link href="/docs" className="hover:text-fd-foreground">
            Docs
          </Link>
          <a href={githubUrl} className="hover:text-fd-foreground">
            GitHub
          </a>
          <a href="https://www.npmjs.com/package/frizz" className="hover:text-fd-foreground">
            npm
          </a>
        </span>
      </footer>
    </main>
  );
}

function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h2 className="text-3xl font-semibold tracking-tight text-balance md:text-4xl">{title}</h2>
      {subtitle && <p className="mt-2 text-lg text-fd-muted-foreground">{subtitle}</p>}
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="font-mono text-fd-foreground">{children}</code>;
}

function More({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="mt-6 inline-flex items-center gap-2 font-medium text-[var(--gold)] hover:underline">
      {children} <ArrowRight className="size-4" />
    </Link>
  );
}

// a heading and its prose beside a screenshot; `flip` puts the picture on the left, so consecutive sections alternate
function Split({
  title,
  children,
  media,
  link,
  flip,
}: {
  title: string;
  children: ReactNode;
  media: ReactNode;
  link: { href: string; text: string };
  flip?: boolean;
}) {
  return (
    <section className="grid gap-10 py-16 md:grid-cols-[1fr_1.3fr] md:items-center">
      <div className={flip ? "md:order-2" : undefined}>
        <Heading title={title} />
        <div className="mt-5 space-y-4 text-lg text-fd-muted-foreground">{children}</div>
        <More href={link.href}>{link.text}</More>
      </div>
      <div className={flip ? "md:order-1" : undefined}>{media}</div>
    </section>
  );
}
