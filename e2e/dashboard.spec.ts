// Full dashboard flow against a running stack backed by the Meta mock.
import { expect, test, type Page } from "@playwright/test";

const EMAIL = process.env.E2E_EMAIL ?? "owner@sandalez.pk";
const PASSWORD = process.env.E2E_PASSWORD ?? "sandalez-dev-pass";
const MEDIA = process.env.E2E_MEDIA_URL ?? "http://127.0.0.1:4010/__mock/media/sample.jpg";
const shots = process.env.E2E_SHOTS;

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("redirects to login and rejects a wrong password", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Wrong email or password/)).toBeVisible();
});

test("overview shows KPIs and charts", async ({ page }) => {
  await login(page);
  for (const label of ["Spend", "Chats", "Cost per chat", "Orders", "Cost per order", "Refusal rate"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText("Spend per day (PKR)")).toBeVisible();
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  await page.getByRole("button", { name: "Table" }).first().click();
  await expect(page.locator("table").first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/overview.png`, fullPage: true });
});

test("wizard creates a paused click-to-WhatsApp campaign", async ({ page }) => {
  const name = `E2E-KHI-${Date.now()}`;
  await login(page);
  await page.getByRole("link", { name: "New campaign" }).first().click();
  await page.getByLabel("Campaign name").fill(name);
  await page.getByLabel("Daily budget (PKR)").fill("5000");
  await expect(page.getByText(/above the cap/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.getByLabel("Daily budget (PKR)").fill("600");
  await page.getByRole("button", { name: "Next", exact: true }).click();

  await page.getByLabel("…or public URL").fill(MEDIA);
  await page.getByLabel("Headline").fill("Pearl flats");
  await page.getByLabel(/Primary text/).fill("Pearl flats ab 30% OFF. COD + easy exchange.");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Welcome message")).toHaveValue(/Sandalez/);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("PKR 600/day")).toBeVisible();
  await page.getByRole("button", { name: "Create paused campaign" }).click();
  await expect(page.getByRole("heading", { name: "Campaign created" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("PAUSED")).toBeVisible();

  await page.getByRole("button", { name: "Go to Campaigns" }).click();
  const card = page.locator("section", { hasText: name }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("Paused").first()).toBeVisible();

  // Budget dialog enforces the cap.
  await card.getByLabel("Toggle ad sets").click();
  await card.getByRole("button", { name: "Budget" }).first().click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("New daily budget (PKR)").fill("5000");
  await expect(dlg.getByText("Above the daily cap.")).toBeVisible();
  await dlg.getByLabel("New daily budget (PKR)").fill("700");
  await dlg.getByRole("button", { name: /Confirm/ }).click();
  await expect(page.getByText(/Budget changed from PKR 600 to PKR 700/)).toBeVisible();

  // Activation needs explicit confirmation and shows the policy reminder.
  await card.getByRole("button", { name: "Activate" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("no misleading claims");
  if (shots) await page.screenshot({ path: `${shots}/activate-dialog.png` });
  await page.getByRole("dialog").getByRole("button", { name: "Yes, activate" }).click();
  await expect(page.getByText(/Activated 3 object\(s\)/)).toBeVisible();
  await expect(card.getByText("Active").first()).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/campaigns.png`, fullPage: true });
});

test("orders: add a row and see it in the log", async ({ page }) => {
  const note = `e2e row ${Date.now()}`;
  await login(page);
  await page.goto("/orders");
  await page.getByRole("button", { name: "Add row" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("Chats").fill("25");
  await dlg.getByLabel("Orders", { exact: true }).fill("8");
  await dlg.getByLabel("Refused (COD returns)").fill("9");
  await expect(dlg.getByText("Refused cannot be more than orders.")).toBeVisible();
  await dlg.getByLabel("Refused (COD returns)").fill("1");
  await dlg.getByLabel("Revenue (PKR)").fill("20000");
  await dlg.getByLabel("Note").fill(note);
  await dlg.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Row added.")).toBeVisible();
  await expect(page.getByText(note)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/orders.png`, fullPage: true });
});

test("every page renders without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  const pages: [string, string][] = [
    ["/campaigns", "Campaigns"],
    ["/creatives", "Creatives"],
    ["/insights", "Insights"],
    ["/audiences", "Audiences"],
    ["/alerts", "Alerts"],
    ["/activity", "Activity log"],
    ["/settings", "Settings"],
  ];
  for (const [path, heading] of pages) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Application error")).toHaveCount(0);
    if (shots) await page.screenshot({ path: `${shots}${path}.png`, fullPage: true });
  }
  await page.goto("/insights");
  await page.getByRole("radio", { name: "Placements" }).click();
  await expect(page.getByText(/marketplace/i).first()).toBeVisible();
  await page.getByRole("radio", { name: "Fatigue" }).click();
  await expect(page.getByText(/look tired/)).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByText("Token is valid and has every permission.")).toBeVisible();
  await page.goto("/activity");
  await expect(page.getByText("set_status").first()).toBeVisible();
  expect(errors).toEqual([]);
});
