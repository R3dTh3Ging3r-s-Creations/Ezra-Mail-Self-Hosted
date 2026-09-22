import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { configureEmailDatabaseForTests } from "@/lib/email/database";
import {
  createSavedView,
  deleteSavedView,
  getSavedViews,
  savedViewToMailFilters,
  updateSavedView,
} from "@/lib/email/saved-views";

describe("Saved Views / Smart Lanes", () => {
  beforeEach(() => {
    configureEmailDatabaseForTests(`file:./saved-views-${randomUUID()}.sqlite`);
  });

  it("returns workspace-aware built-in lanes with mail filter definitions", async () => {
    const gmail = await getSavedViews({ workspaceId: "workspace:gmail" });
    const hotmail = await getSavedViews({ workspaceId: "workspace:microsoft" });
    const job = gmail.items.find((item) => item.id === "builtin:job-search");
    const security = hotmail.items.find((item) => item.id === "builtin:security");

    expect(gmail.workspaceId).toBe("workspace:gmail");
    expect(gmail.items.length).toBeGreaterThanOrEqual(10);
    expect(gmail.items.every((item) => item.workspaceId === "workspace:gmail")).toBe(true);
    expect(gmail.items.every((item) => item.accountScopeLabel === "Gmail workspace")).toBe(true);
    expect(job).toMatchObject({
      label: "Job search",
      isBuiltin: true,
      isAllAccounts: false,
      definition: {
        kind: "mail",
        semanticKey: "job_search",
        filters: expect.objectContaining({
          folder: "inbox",
          handled: "active",
          categories: expect.arrayContaining(["job application", "interview request"]),
        }),
      },
    });
    expect(security).toMatchObject({
      workspaceId: "workspace:microsoft",
      accountScopeLabel: "Hotmail workspace",
      definition: {
        filters: expect.objectContaining({
          categories: expect.arrayContaining(["account-security", "fraud"]),
        }),
      },
    });
  });

  it("marks All accounts lanes as explicit blended views", async () => {
    const all = await getSavedViews({ workspaceId: "workspace:all" });

    expect(all.workspaceId).toBe("workspace:all");
    expect(all.items.every((item) => item.isAllAccounts)).toBe(true);
    expect(all.items.every((item) => item.accountScopeLabel.includes("explicit blend"))).toBe(true);
  });

  it("persists, updates, disables, and deletes custom saved views without altering built-ins", async () => {
    const created = await createSavedView({
      workspaceId: "workspace:microsoft",
      label: "Book submissions",
      description: "Editors, publishers, and submissions.",
      definition: {
        kind: "mail",
        semanticKey: "book_submissions_custom",
        sort: "priority",
        filters: {
          folder: "inbox",
          categories: ["submission", "publishing"],
          search: "submission editor",
          handled: "active",
        },
      },
    });
    const withCustom = await getSavedViews({ workspaceId: "workspace:microsoft" });
    const custom = withCustom.items.find((item) => item.id === created.id);

    expect(custom).toMatchObject({
      isBuiltin: false,
      workspaceId: "workspace:microsoft",
      label: "Book submissions",
      definition: {
        semanticKey: "book_submissions_custom",
        filters: expect.objectContaining({
          categories: ["submission", "publishing"],
          search: "submission editor",
        }),
      },
    });
    expect(withCustom.items.find((item) => item.id === "builtin:submissions")).toMatchObject({
      isBuiltin: true,
      label: "Submissions",
    });

    const updated = await updateSavedView({
      id: created.id,
      label: "Submissions I care about",
      isEnabled: false,
      definition: {
        kind: "mail",
        sort: "newest",
        filters: {
          folder: "all",
          search: "query manuscript",
          date: "last30",
          handled: "any",
        },
      },
    });
    const afterDisable = await getSavedViews({ workspaceId: "workspace:microsoft" });

    expect(updated).toMatchObject({
      label: "Submissions I care about",
      isEnabled: false,
      definition: {
        filters: expect.objectContaining({
          folder: "all",
          search: "query manuscript",
          date: "last30",
        }),
      },
    });
    expect(afterDisable.items.some((item) => item.id === created.id)).toBe(false);

    await updateSavedView({ id: created.id, isEnabled: true });
    await deleteSavedView(created.id);
    const afterDelete = await getSavedViews({ workspaceId: "workspace:microsoft" });

    expect(afterDelete.items.some((item) => item.id === created.id)).toBe(false);
    expect(afterDelete.items.some((item) => item.id === "builtin:submissions")).toBe(true);
  });

  it("normalizes custom lane definitions into reusable Mail filters", async () => {
    const custom = await createSavedView({
      workspaceId: "workspace:gmail",
      label: "Receipts with files",
      definition: {
        kind: "mail",
        sort: "oldest",
        filters: {
          folder: "all",
          priority: "digest",
          category: " Receipt ",
          categories: ["Receipt", "Transaction", ""],
          unread: false,
          attachments: true,
          date: "last7",
          search: " invoice   receipt ",
          needsReply: false,
          handled: "any",
        },
      },
    });

    expect(savedViewToMailFilters(custom)).toEqual({
      folder: "all",
      priority: "digest",
      category: "receipt",
      categories: ["receipt", "transaction"],
      unread: false,
      attachments: true,
      date: "last7",
      search: "invoice receipt",
      needsReply: false,
      handled: "any",
    });
  });

  it("protects built-in saved views from direct mutation", async () => {
    await expect(updateSavedView({ id: "builtin:job-search", label: "Nope" }))
      .rejects.toThrow("Saved view was not found");
    await expect(deleteSavedView("builtin:job-search"))
      .rejects.toThrow("Saved view was not found");
  });
});
