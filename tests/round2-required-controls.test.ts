import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import type { ContactRequest } from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/forms_types_(Support).js";
import {
  assess_required_control_inventory,
  temporarily_disable_inactive_required_controls,
} from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/required_control_inventory_(Deterministic).js";
import { satisfy_undefined_field_fallback } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/B_population/B5_undefined_field_fallback_(Deterministic).js";

const CONTACT_REQUEST: ContactRequest = {
  websiteUrl: "https://example.test/contact",
  name: "Test User",
  email: "test@example.com",
  phone: "050-0000000",
  message: "Please contact me.",
};

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser.close();
});

test("Round 2 completes active native required controls deterministically", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <input name="confirm_email" type="email" required>
      <input name="confirm_phone" type="tel" required>
      <input name="reference" minlength="10" maxlength="12" required>
      <input name="data_reference" data-required="true" minlength="6">
      <select name="department" required>
        <option value="">Choose department</option>
        <option value="sales">Sales</option>
      </select>
      <fieldset aria-required="true">
        <legend>Priority</legend>
        <label><input type="radio" name="priority" value="standard"> Standard</label>
        <label><input type="radio" name="priority" value="urgent"> Urgent</label>
      </fieldset>
      <label><input type="checkbox" name="required_updates" required> Updates</label>
    </form>
  `);

  const report = await satisfy_undefined_field_fallback(
    page.locator("form"),
    CONTACT_REQUEST,
  );
  const state = await page.locator("form").evaluate((form) => {
    const controls = (form as HTMLFormElement).elements as unknown as {
      confirm_email: HTMLInputElement;
      confirm_phone: HTMLInputElement;
      reference: HTMLInputElement;
      data_reference: HTMLInputElement;
      department: HTMLSelectElement;
      priority: RadioNodeList;
      required_updates: HTMLInputElement;
    };
    return {
      email: controls.confirm_email.value,
      phone: controls.confirm_phone.value,
      referenceLength: controls.reference.value.length,
      dataReferenceLength: controls.data_reference.value.length,
      department: controls.department.value,
      priority: controls.priority.value,
      updates: controls.required_updates.checked,
      valid: (form as HTMLFormElement).checkValidity(),
    };
  });

  assert.deepEqual(state, {
    email: CONTACT_REQUEST.email,
    phone: CONTACT_REQUEST.phone,
    referenceLength: 10,
    dataReferenceLength: 10,
    department: "sales",
    priority: "standard",
    updates: true,
    valid: true,
  });
  assert.equal(report.summary.duplicateContactFieldsFilled, 2);
  assert.equal(report.summary.unknownTextFieldsFilled, 2);
  assert.equal(report.summary.dropdownsSelected, 1);
  assert.equal(report.summary.radioChoicesSelected, 1);
  assert.equal(report.summary.checkboxChoicesSelected, 1);
  assert.equal(report.summary.unresolvedActiveRequiredControls, 0);
  await page.close();
});

test("Round 2 skips Hebrew dropdown placeholders", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <select name="department" required>
        <option value="">נא לבחור מחלקה</option>
        <option value="sales">מכירות</option>
      </select>
    </form>
  `);
  const report = await satisfy_undefined_field_fallback(
    page.locator("form"),
    CONTACT_REQUEST,
  );
  assert.equal(await page.locator("select").inputValue(), "sales");
  assert.equal(report.summary.dropdownsSelected, 1);
  assert.equal(report.summary.unresolvedActiveRequiredControls, 0);
  await page.close();
});

test("Round 2 completes uniquely scoped simple ARIA widgets", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <div id="combo" role="combobox" aria-required="true" aria-controls="options">Choose service</div>
      <div id="options" role="listbox" hidden>
        <div role="option" aria-selected="false">Consulting</div>
      </div>
      <div id="radio-group" role="radiogroup" aria-required="true">
        <button type="button" role="radio" aria-checked="false">Email</button>
      </div>
      <div id="checkbox" role="checkbox" aria-required="true" aria-checked="false">Agree</div>
    </form>
    <script>
      const combo = document.querySelector('#combo');
      const options = document.querySelector('#options');
      combo.onclick = () => { options.hidden = false; };
      options.querySelector('[role=option]').onclick = (event) => {
        event.currentTarget.setAttribute('aria-selected', 'true');
        combo.textContent = event.currentTarget.textContent;
        options.hidden = true;
      };
      document.querySelector('[role=radio]').onclick = (event) => {
        event.currentTarget.setAttribute('aria-checked', 'true');
      };
      document.querySelector('#checkbox').onclick = (event) => {
        event.currentTarget.setAttribute('aria-checked', 'true');
      };
    </script>
  `);

  const report = await satisfy_undefined_field_fallback(
    page.locator("form"),
    CONTACT_REQUEST,
  );

  assert.equal(report.summary.customChoicesSelected, 3);
  assert.equal(
    await page.locator('#options [role="option"]').getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    await page.locator('[role="radio"]').getAttribute("aria-checked"),
    "true",
  );
  assert.equal(
    await page.locator('#checkbox').getAttribute("aria-checked"),
    "true",
  );
  await page.close();
});

test("Round 2 temporarily disables only confidently inactive conditionals", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <section hidden>
        <label>Other topic <input name="inactive_topic" required></label>
      </section>
      <label>Visible email <input name="email" type="email" required value="test@example.com"></label>
    </form>
  `);

  const lease = await temporarily_disable_inactive_required_controls(
    page.locator("form"),
  );
  const during = await page.locator("form").evaluate((form) => ({
    valid: (form as HTMLFormElement).checkValidity(),
    keys: [...new FormData(form as HTMLFormElement).keys()],
    hiddenDisabled: (
      (form as HTMLFormElement).elements.namedItem(
        "inactive_topic",
      ) as HTMLInputElement
    ).disabled,
  }));

  assert.equal(lease.disabledControls.length, 1);
  assert.deepEqual(during, {
    valid: true,
    keys: ["email"],
    hiddenDisabled: true,
  });
  assert.deepEqual(await lease.restore(), {
    attempted: 1,
    restored: 1,
    detached: 0,
    failed: 0,
  });
  assert.equal(await page.locator('[name="inactive_topic"]').isDisabled(), false);
  await page.close();
});

test("Round 2 does not treat visible styled backing controls as inactive", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <label>Topic
        <select name="topic" required style="visibility:hidden;width:1px;height:1px">
          <option value="">Choose topic</option>
          <option value="sales">Sales</option>
        </select>
        <button type="button" role="combobox">Choose topic</button>
      </label>
    </form>
  `);

  const inventory = await assess_required_control_inventory(page.locator("form"));
  assert.equal(inventory.counts.inactiveHiddenConditional, 0);
  assert.equal(inventory.counts.activeCustomBacked, 1);
  await page.close();
});

test("Round 2 refresh stops disabling a conditional that becomes active", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <section id="conditional-panel" hidden>
        <label>Other topic <input name="other_topic" required></label>
      </section>
    </form>
  `);

  const first = await temporarily_disable_inactive_required_controls(
    page.locator("form"),
  );
  assert.equal(first.disabledControls.length, 1);
  await first.restore();
  await page.locator("#conditional-panel").evaluate((panel) => {
    (panel as HTMLElement).hidden = false;
  });

  const refreshed = await temporarily_disable_inactive_required_controls(
    page.locator("form"),
  );
  assert.equal(refreshed.disabledControls.length, 0);
  assert.equal(refreshed.inventory.counts.activeNative, 1);
  assert.equal(await page.locator('[name="other_topic"]').isDisabled(), false);
  await refreshed.restore();
  await page.close();
});

test("Round 2 leaves unsafe required controls unresolved", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <label>Security quiz <input name="quiz_answer" required></label>
      <label>Attachment <input name="attachment" type="file" required></label>
    </form>
  `);

  const report = await satisfy_undefined_field_fallback(
    page.locator("form"),
    CONTACT_REQUEST,
  );
  assert.equal(report.summary.skippedUnsafeFields, 2);
  assert.equal(report.summary.unresolvedActiveRequiredControls, 2);
  assert.equal(await page.locator('[name="quiz_answer"]').inputValue(), "");
  await page.close();
});
