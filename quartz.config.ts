import { QuartzConfig } from "./quartz/cfg"
import * as Plugin from "./quartz/plugins"

/**
 * Quartz 4 Configuration
 *
 * See https://quartz.jzhao.xyz/configuration for more information.
 */
const config: QuartzConfig = {
  configuration: {
    pageTitle: "Notes",
    pageTitleSuffix: "",
    enableSPA: true,
    enablePopovers: false,
    analytics: null,
    locale: "en-US",
    baseUrl: "notes.josephrex.me",
    ignorePatterns: ["private", "templates", ".obsidian"],
    defaultDateType: "created",
    theme: {
      fontOrigin: "googleFonts",
      cdnCaching: true,
      typography: {
        header: "Inter",
        body: "Inter",
        code: "IBM Plex Mono",
      },
      colors: {
        lightMode: {
          light: "#ffffff",
          lightgray: "#f0f0f0",
          gray: "#cccccc",
          darkgray: "#444444",
          dark: "#111111",
          secondary: "#000000",
          tertiary: "#666666",
          highlight: "rgba(0, 0, 0, 0.05)",
          textHighlight: "rgba(0, 0, 0, 0.1)",
        },
        darkMode: {
          light: "#111111",
          lightgray: "#222222",
          gray: "#444444",
          darkgray: "#cccccc",
          dark: "#ffffff",
          secondary: "#ffffff",
          tertiary: "#aaaaaa",
          highlight: "rgba(255, 255, 255, 0.1)",
          textHighlight: "rgba(255, 255, 255, 0.2)",
        },
      },
    },
  },
  plugins: {
    transformers: [
      Plugin.FrontMatter(),
      Plugin.CreatedModifiedDate({
        priority: ["frontmatter", "git", "filesystem"],
      }),
      Plugin.SyntaxHighlighting({
        theme: {
          light: "github-light",
          dark: "github-dark",
        },
        keepBackground: false,
      }),
      Plugin.ObsidianFlavoredMarkdown({ enableInHtmlEmbed: false }),
      Plugin.GitHubFlavoredMarkdown(),
      Plugin.TableOfContents(),
      Plugin.CrawlLinks({ markdownLinkResolution: "shortest" }),
      Plugin.Description(),
      Plugin.Latex({ renderEngine: "katex" }),
    ],
    filters: [Plugin.RemoveDrafts()],
    emitters: [
      Plugin.AliasRedirects(),
      Plugin.ComponentResources(),
      Plugin.ContentPage(),
      Plugin.FolderPage(),
      Plugin.TagPage(),
      Plugin.ContentIndex({
        enableSiteMap: true,
        enableRSS: true,
      }),
      Plugin.Assets(),
      Plugin.Static(),
      Plugin.Favicon(),
      Plugin.NotFoundPage(),
      // Comment out CustomOgImages to speed up build time
      Plugin.CustomOgImages(),
    ],
  },
}

export default config
