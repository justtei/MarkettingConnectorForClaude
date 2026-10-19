// Mobile-first check: the dashboard is usable at phone width with no horizontal scroll.
import { expect, test } from "@playwright/test";

test("mobile overview and navigation", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(process.env.E2E_EMAIL ?? "owner@sandalez.pk");
  await page.getByLabel("Password").fill(process.env.E2E_PASSWORD ?? "sandalez-dev-pass");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  for (const path of ["/", "/campaigns", "/orders", "/new"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
  await page.goto("/");
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/mobile-settings.png`, fullPage: true });
});
