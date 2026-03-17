import { PageLayout, SharedLayout } from "./quartz/cfg"
import * as Component from "./quartz/components"

// components shared across all pages
export const sharedPageComponents: SharedLayout = {
  head: Component.Head(),
  header: [
    Component.PageTitle(),
    Component.Spacer(),
    Component.Darkmode(),
  ],
  afterBody: [
    Component.ConditionalRender({
      component: Component.RecentNotes({
        title: "All Notes",
        limit: 100,
        showTags: false,
        filter: (f) => f.slug !== "index",
      }),
      condition: (page) => page.fileData.slug === "index",
    }),
  ],
  footer: Component.Footer({
    links: {},
  }),
}

// components for pages that display a single page (e.g. a single note)
export const defaultContentPageLayout: PageLayout = {
  beforeBody: [
    Component.ConditionalRender({
      component: Component.ArticleTitle(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.ConditionalRender({
      component: Component.ContentMeta(),
      condition: (page) => page.fileData.slug !== "index",
    }),
    Component.TagList(),
  ],
  left: [],
  right: [],
}


// components for pages that display lists of pages  (e.g. tags or folders)
export const defaultListPageLayout: PageLayout = {
  beforeBody: [Component.ArticleTitle(), Component.ContentMeta()],
  left: [],
  right: [],
}
