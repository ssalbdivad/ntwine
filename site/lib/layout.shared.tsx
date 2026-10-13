import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Wordmark } from "@/components/logo";

export const githubUrl = "https://github.com/colinhacks/frizz";

export const baseOptions: BaseLayoutProps = {
  nav: { title: <Wordmark /> },
  githubUrl,
  links: [
    { text: "Docs", url: "/docs", active: "nested-url" },
    { text: "npm", url: "https://www.npmjs.com/package/ntwine", external: true },
  ],
};
