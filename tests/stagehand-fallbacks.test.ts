import assert from "node:assert/strict";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import type {
  PageIntelligence,
  PageIntelligenceAction,
  PageIntelligenceActRequest,
  PageIntelligenceActResult,
  PageIntelligenceExtractRequest,
  PageIntelligenceExtractResult,
  PageIntelligenceObserveRequest,
  PageIntelligenceObserveResult,
  PageIntelligenceVariableName,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/page_intelligence_(Integration).js";
import {
  create_page_intelligence_scope,
  with_masked_page_values,
} from "../src/contact_outreach_workflow/shared_files_orchestrator/page_value_redaction_(Integration).js";
import type {
  ContactFormCandidate,
  ContactRequest,
  PopulatedField,
} from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/forms_types_(Support).js";
import { discover_contact_form } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/A_discovery/A1_contact_form_discovery_(Integration).js";
import { discover_contact_form_with_stagehand_fallback } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/A_discovery/A2_stagehand_discovery_fallback_(LLM).js";
import { assess_contact_form } from "../src/contact_outreach_workflow/contact_channels/forms/shared_files_forms/contact_form_intent_(Deterministic).js";
import { populate_contact_form } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/B_population/B1_contact_form_population_(Integration).js";
import { populate_contact_form_with_stagehand_fallback } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/B_population/B6_stagehand_population_fallback_(LLM).js";
import { attempt_stagehand_submission_fallback } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/C_submission/C8_stagehand_submission_fallback_(LLM).js";
import { classify_stagehand_submission_confirmation } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/C_submission/C9_stagehand_confirmation_fallback_(LLM).js";
import { submit_and_assess_contact_form } from "../src/contact_outreach_workflow/contact_channels/forms/pipeline/C_submission/C1_contact_form_submission_(Integration).js";

let browser: Browser;

test.before(async () => {
  browser = await chromium.launch({ headless: true });
});

test.after(async () => {
  await browser.close();
});

test("Stagehand discovery executes one safe same-origin action then rediscovery", async () => {
  await with_page(
    `<button id="contact">Contact our team</button>
     <section id="contact-panel" style="display:none">
       <form><input type="email"><textarea></textarea><button>Send</button></form>
     </section>
     <script>document.querySelector('#contact').onclick = () => { document.querySelector('#contact-panel').style.display = 'block'; };</script>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: () => [click_action("#contact", "Contact our team")],
      });
      const session = {
        page,
        pageIntelligence: intelligence,
        close: async () => undefined,
      };

      const result = await discover_contact_form_with_stagehand_fallback(
        session,
        { contactPageFound: false, reason: "contact page not found" },
        async () => {
          const form = page.locator("form");
          return (await form.isVisible())
            ? candidate_for(page, form)
            : undefined;
        },
      );

      assert.equal(result.contactPageFound, true);
      assert.equal(await result.candidate?.form.isVisible(), true);
      assert.equal(intelligence.actCalls.length, 0);
      assert.equal(result.aiActions?.[0]?.result, "succeeded");
    },
  );
});

test("Stagehand discovery rejects cross-origin navigation", async () => {
  await with_page(
    `<a id="external" href="https://example.org/contact">Contact</a>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: () => [click_action("#external", "External contact")],
      });
      const result = await discover_contact_form_with_stagehand_fallback(
        {
          page,
          pageIntelligence: intelligence,
          close: async () => undefined,
        },
        { contactPageFound: false, reason: "contact page not found" },
        async () => undefined,
      );

      assert.equal(result.candidate, undefined);
      assert.equal(intelligence.actCalls.length, 0);
      assert.match(result.reason ?? "", /same-origin|Stagehand fallback/i);
      assert.equal(result.aiActions?.[0]?.acceptance, "rejected");
    },
  );
});

test("Stagehand discovery normalizes a field locator to its visible form", async () => {
  await with_page(
    `<form id="contact-panel">
       <h2>Contact support</h2>
       <input type="email"><textarea></textarea>
       <button>Send</button>
     </form>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: () => [click_action("#contact-panel textarea", "Contact message field")],
      });
      const result = await discover_contact_form_with_stagehand_fallback(
        {
          page,
          pageIntelligence: intelligence,
          close: async () => undefined,
        },
        { contactPageFound: false, reason: "contact page not found" },
        async () => undefined,
      );

      assert.ok(
        result.candidate,
        `${result.reason}; ${JSON.stringify(result.aiActions)}`,
      );
      assert.equal(result.candidate.source, "stagehand");
      assert.equal(await result.candidate?.form.isVisible(), true);
      assert.equal(await result.candidate?.form.getAttribute("id"), "contact-panel");
      assert.equal(intelligence.actCalls.length, 0);
    },
  );
});

test("Stagehand discovery semantically recovers a structurally strong business inquiry with misleading sign-in text", async () => {
  await with_page(
    `<main>
       <h1>Contact our team</h1>
       <p>Existing clients can sign in elsewhere.</p>
       <form id="business-inquiry">
         <p>Sign in access is available for existing clients.</p>
         <label>Name <input name="name"></label>
         <label>Business email <input type="email" name="email"></label>
         <label>Company <input name="company"></label>
         <label>Project description <textarea name="project-description"></textarea></label>
         <button type="submit">Send project inquiry</button>
       </form>
       <div id="submission-status"></div>
       <script>
         window.submitClicks = 0;
         document.querySelector('#business-inquiry').addEventListener('submit', (event) => {
           event.preventDefault();
           window.submitClicks += 1;
           document.querySelector('#submission-status').textContent = 'Your inquiry was successfully submitted.';
         });
       </script>
     </main>`,
    async (page) => {
      const deterministic_assessment = await assess_contact_form(
        page.locator("#business-inquiry"),
      );
      assert.equal(deterministic_assessment.accepted, false);
      assert.equal(deterministic_assessment.signals.hasNegativeContext, true);

      const previous_recovery_setting =
        process.env.CONTACT_FORM_STAGEHAND_SEMANTIC_RECOVERY;
      process.env.CONTACT_FORM_STAGEHAND_SEMANTIC_RECOVERY = "off";
      try {
        const baseline_intelligence = new FakePageIntelligence({
          observe: () => [
            click_action(
              "#business-inquiry textarea",
              "Project description field",
            ),
          ],
          extract: () => ({
            purpose: "business_contact_inquiry",
            acceptsBusinessInquiry: true,
          }),
        });
        const baseline = await discover_contact_form_with_stagehand_fallback(
          {
            page,
            pageIntelligence: baseline_intelligence,
            close: async () => undefined,
          },
          { contactPageFound: false, reason: "contact page not found" },
          async () => undefined,
        );
        assert.equal(baseline.candidate, undefined);
        assert.equal(baseline_intelligence.extractCalls.length, 0);
      } finally {
        if (previous_recovery_setting === undefined) {
          delete process.env.CONTACT_FORM_STAGEHAND_SEMANTIC_RECOVERY;
        } else {
          process.env.CONTACT_FORM_STAGEHAND_SEMANTIC_RECOVERY =
            previous_recovery_setting;
        }
      }

      const intelligence = new FakePageIntelligence({
        observe: () => [
          click_action("#business-inquiry textarea", "Project description field"),
        ],
        extract: () => ({
          purpose: "business_contact_inquiry",
          acceptsBusinessInquiry: true,
        }),
      });
      const result = await discover_contact_form_with_stagehand_fallback(
        { page, pageIntelligence: intelligence, close: async () => undefined },
        { contactPageFound: false, reason: "contact page not found" },
        async () => undefined,
      );

      assert.ok(result.candidate, result.reason);
      assert.equal(result.candidate.classification, "complete");
      assert.equal(result.candidate.messageDisposition, "unresolved");
      assert.equal(intelligence.extractCalls.length, 1);
      assert.equal(intelligence.actCalls.length, 0);
      assert.equal(
        result.aiActions?.some(
          (action) =>
            action.method === "extract" && action.acceptance === "accepted",
        ),
        true,
      );

      const population = await populate_contact_form(
        contact_request(),
        result.candidate,
      );
      assert.equal(population.blockingReason, undefined, population.blockingReason);
      const submission = await submit_and_assess_contact_form(
        { page, close: async () => undefined },
        result.candidate,
        {
          contactRequest: contact_request(),
          populationHandoff: population.submissionHandoff,
        },
      );
      assert.equal(
        submission.confirmed,
        true,
        `${submission.reason}; status=${await page.locator("#submission-status").innerText()}; clicks=${await page.evaluate(() => (window as unknown as { submitClicks: number }).submitClicks)}`,
      );
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { submitClicks: number }).submitClicks,
        ),
        1,
      );
    },
  );
});

test("Stagehand discovery keeps a structurally strong form rejected when semantic purpose is not a business inquiry", async () => {
  await with_page(
    `<main>
       <h1>Contact and sign in</h1>
       <form id="account-form">
         <label>Name <input name="name"></label>
         <label>Email <input type="email" name="email"></label>
         <label>Company <input name="company"></label>
         <label>Project message <textarea name="project-message"></textarea></label>
         <button type="submit">Continue</button>
       </form>
     </main>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: () => [click_action("#account-form textarea", "Message field")],
        extract: () => ({
          purpose: "search_or_login",
          acceptsBusinessInquiry: false,
        }),
      });
      const result = await discover_contact_form_with_stagehand_fallback(
        { page, pageIntelligence: intelligence, close: async () => undefined },
        { contactPageFound: false, reason: "contact page not found" },
        async () => undefined,
      );

      assert.equal(result.candidate, undefined);
      assert.equal(intelligence.extractCalls.length, 1);
      assert.equal(intelligence.actCalls.length, 0);
      assert.equal(
        result.aiActions?.some(
          (action) =>
            action.method === "extract" && action.acceptance === "rejected",
        ),
        true,
      );
    },
  );
});

test("Stagehand discovery never extracts semantic purpose for a weak rejected form", async () => {
  await with_page(
    `<form id="weak-search">
       <input type="email" name="email">
       <input name="query">
       <button type="submit">Search</button>
     </form>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: () => [click_action("#weak-search input", "Search field")],
        extract: () => ({
          purpose: "business_contact_inquiry",
          acceptsBusinessInquiry: true,
        }),
      });
      const result = await discover_contact_form_with_stagehand_fallback(
        { page, pageIntelligence: intelligence, close: async () => undefined },
        { contactPageFound: false, reason: "contact page not found" },
        async () => undefined,
      );

      assert.equal(result.candidate, undefined);
      assert.equal(intelligence.extractCalls.length, 0);
      assert.equal(intelligence.actCalls.length, 0);
    },
  );
});

test("Stagehand discovery rejects a CAPTCHA-targeted selector before semantic extraction", async () => {
  await with_page(
    `<main>
       <h1>Contact our team</h1><p>Sign in for existing clients.</p>
       <form id="captcha-inquiry">
         <input name="name"><input type="email" name="email"><input name="company">
         <textarea name="project-message"></textarea>
         <div id="captcha" class="g-recaptcha">Verification</div>
         <button type="submit">Send inquiry</button>
       </form>
     </main>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: () => [click_action("#captcha", "Verification control")],
        extract: () => ({
          purpose: "business_contact_inquiry",
          acceptsBusinessInquiry: true,
        }),
      });
      const result = await discover_contact_form_with_stagehand_fallback(
        { page, pageIntelligence: intelligence, close: async () => undefined },
        { contactPageFound: false, reason: "contact page not found" },
        async () => undefined,
      );

      assert.equal(result.candidate, undefined);
      assert.equal(intelligence.extractCalls.length, 0);
      assert.equal(intelligence.actCalls.length, 0);
      assert.match(result.reason ?? "", /CAPTCHA/);
    },
  );
});

test("accepted deterministic discovery never initializes PageIntelligence", async () => {
  await with_page(
    `<form id="contact"><input type="email"><textarea></textarea><button>Send</button></form>`,
    async (page) => {
      let initialization_count = 0;
      const deterministic_candidate = candidate_for(page, page.locator("#contact"));
      const result = await discover_contact_form_with_stagehand_fallback(
        {
          page,
          ensurePageIntelligence: async () => {
            initialization_count += 1;
            return new FakePageIntelligence();
          },
          close: async () => undefined,
        },
        { contactPageFound: true, candidate: deterministic_candidate },
        async () => undefined,
      );

      assert.equal(result.candidate, deterministic_candidate);
      assert.equal(initialization_count, 0);
    },
  );
});

test("Stagehand discovery strips click arguments before Playwright navigation", async () => {
  await with_page(
    `<button id="consultation">Book a Call</button>
     <form style="display:none"><h2>Book a consultation</h2><input type="email"><input name="name"><button>Request call</button></form>
     <script>document.querySelector('#consultation').onclick = () => { document.querySelector('form').style.display = 'block'; };</script>`,
    async (page) => {
      const action = click_action("#consultation", "Book a Call");
      action.arguments = ["irrelevant"];
      const intelligence = new FakePageIntelligence({ observe: () => [action] });
      const result = await discover_contact_form_with_stagehand_fallback(
        { page, pageIntelligence: intelligence, close: async () => undefined },
        { contactPageFound: false, reason: "contact page not found" },
        async () => {
          const form = page.locator("form");
          return (await form.isVisible()) ? candidate_for(page, form) : undefined;
        },
      );

      assert.ok(result.candidate);
      assert.equal(intelligence.actCalls.length, 0);
      assert.equal(result.aiActions?.[0]?.argumentCount, 1);
      assert.match(result.aiActions?.[0]?.normalization ?? "", /removed 1/);
    },
  );
});

test("Stagehand discovery resolves a child selector to its safe button ancestor", async () => {
  await with_page(
    `<button id="project"><span id="project-label">Start a Project</span></button>
     <form style="display:none"><h2>Start a Project</h2><input type="email"><input name="company"><button>Request project</button></form>
     <script>document.querySelector('#project').onclick = () => { document.querySelector('form').style.display = 'block'; };</script>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: () => [click_action("#project-label", "Start a Project")],
      });
      const result = await discover_contact_form_with_stagehand_fallback(
        { page, pageIntelligence: intelligence, close: async () => undefined },
        { contactPageFound: false, reason: "contact page not found" },
        async () => {
          const form = page.locator("form");
          return (await form.isVisible()) ? candidate_for(page, form) : undefined;
        },
      );

      assert.ok(result.candidate);
      assert.match(result.aiActions?.[0]?.normalization ?? "", /nearest link\/button ancestor/);
    },
  );
});

test("Stagehand discovery retries one technical observation failure", async () => {
  await with_page("<main>No form</main>", async (page) => {
    const intelligence = new FakePageIntelligence({
      observe: () => {
        throw new Error("observation timeout");
      },
    });
    const result = await discover_contact_form_with_stagehand_fallback(
      { page, pageIntelligence: intelligence, close: async () => undefined },
      { contactPageFound: false, reason: "contact page not found" },
      async () => undefined,
    );

    assert.equal(intelligence.observeCalls.length, 2);
    assert.match(result.reason ?? "", /timeout|invalid Stagehand output/i);
  });
});

test("Stagehand discovery does not retry a valid empty observation", async () => {
  await with_page("<main>No form</main>", async (page) => {
    const intelligence = new FakePageIntelligence({ observe: () => [] });
    const result = await discover_contact_form_with_stagehand_fallback(
      { page, pageIntelligence: intelligence, close: async () => undefined },
      { contactPageFound: false, reason: "contact page not found" },
      async () => undefined,
    );

    assert.equal(intelligence.observeCalls.length, 1);
    assert.match(result.reason ?? "", /no candidate action/);
  });
});

test("Stagehand discovery stops after two navigation clicks", async () => {
  await with_page(
    `<button id="contact">Contact</button><button id="help">Help</button>`,
    async (page) => {
      let observation_count = 0;
      const intelligence = new FakePageIntelligence({
        observe: (request) => {
          observation_count += 1;
          return [
            click_action(
              observation_count === 1 ? "#contact" : "#help",
              request.instruction,
            ),
          ];
        },
      });
      const result = await discover_contact_form_with_stagehand_fallback(
        {
          page,
          pageIntelligence: intelligence,
          close: async () => undefined,
        },
        { contactPageFound: false, reason: "contact page not found" },
        async () => undefined,
      );

      assert.equal(result.candidate, undefined);
      assert.equal(intelligence.observeCalls.length, 2);
      assert.equal(intelligence.actCalls.length, 0);
      assert.match(intelligence.observeCalls[1]?.instruction ?? "", /#contact/);
      assert.match(
        intelligence.observeCalls[1]?.instruction ?? "",
        /already-clicked selectors/,
      );
    },
  );
});

test("Stagehand discovery continues when passive CAPTCHA markup appears", async () => {
  await with_page(
    `<button id="contact">Contact</button>
     <script>document.querySelector('#contact').onclick = () => {
       const captcha = document.createElement('div');
       captcha.className = 'captcha-challenge';
       document.body.append(captcha);
     };</script>`,
    async (page) => {
      let observations = 0;
      const intelligence = new FakePageIntelligence({
        observe: () =>
          observations++ === 0 ? [click_action("#contact", "Contact")] : [],
      });
      const result = await discover_contact_form_with_stagehand_fallback(
        {
          page,
          pageIntelligence: intelligence,
          close: async () => undefined,
        },
        { contactPageFound: false, reason: "contact page not found" },
        async () => undefined,
      );

      assert.equal(intelligence.observeCalls.length, 2);
      assert.equal(intelligence.actCalls.length, 0);
      assert.doesNotMatch(result.reason ?? "", /CAPTCHA/);
      assert.ok(intelligence.observeCalls[1]?.ignoreSelectors?.length);
    },
  );
});

test("Stagehand discovery may act safely when CAPTCHA markup appears during observation", async () => {
  await with_page(`<button id="contact">Contact</button>`, async (page) => {
    const intelligence = new FakePageIntelligence({
      observe: async (request) => {
        if (await request.page.locator(".captcha-challenge").count()) {
          return [];
        }
        await request.page.evaluate(() => {
          const captcha = document.createElement("div");
          captcha.className = "captcha-challenge";
          document.body.append(captcha);
        });
        return [click_action("#contact", "Contact")];
      },
    });
    const result = await discover_contact_form_with_stagehand_fallback(
      {
        page,
        pageIntelligence: intelligence,
        close: async () => undefined,
      },
      { contactPageFound: false, reason: "contact page not found" },
      async () => undefined,
    );

    assert.equal(intelligence.observeCalls.length, 2);
    assert.equal(intelligence.actCalls.length, 0);
    assert.doesNotMatch(result.reason ?? "", /CAPTCHA/);
  });
});

test("Stagehand discovery stops an href-less button that navigates cross-origin", async () => {
  await with_page("<main></main>", async (page) => {
    await page.route("http://local.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: `<button id="contact">Contact</button>
          <script>document.querySelector('#contact').onclick = () => {
            setTimeout(() => { location.href = 'http://other.test/contact'; }, 500);
          };</script>`,
      });
    });
    await page.route("http://other.test/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<main>External contact page</main>",
      });
    });
    await page.goto("http://local.test/");

    const intelligence = new FakePageIntelligence({
      observe: () => [click_action("#contact", "Contact")],
    });
    const result = await discover_contact_form_with_stagehand_fallback(
      {
        page,
        pageIntelligence: intelligence,
        close: async () => undefined,
      },
      { contactPageFound: false, reason: "contact page not found" },
      async () => undefined,
    );

    assert.equal(intelligence.observeCalls.length, 1);
    assert.equal(intelligence.actCalls.length, 0);
    assert.match(result.reason ?? "", /cross-origin/);
    assert.equal(new URL(page.url()).origin, "http://local.test");
  });
});

test("generic contact-link transport failures do not invoke PageIntelligence", async () => {
  await with_page("<main></main>", async (page) => {
    await page.route("http://local.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<a href="/contact">Contact us</a>',
      }),
    );
    await page.route("http://local.test/contact", (route) => route.abort());
    await page.goto("http://local.test/");
    const intelligence = new FakePageIntelligence();

    const result = await discover_contact_form(
      {
        page,
        pageIntelligence: intelligence,
        close: async () => undefined,
      },
      "http://local.test/",
    );

    assert.equal(result.transportFailure, true);
    assert.equal(intelligence.observeCalls.length, 0);
    assert.equal(intelligence.actCalls.length, 0);
  });
});

test("population masks existing contact values and fills only an approved placeholder", async () => {
  await with_page(
    `<form>
       <input id="known-name" value="Test User">
       <input id="known-email" type="email" value="test@example.com">
       <input id="hidden-email" type="hidden" value="test@example.com">
       <input id="message-proxy" required value="Hello">
     </form>
     <aside id="mirrored-email">test@example.com</aside>`,
    async (page) => {
      const request = contact_request();
      const intelligence = new FakePageIntelligence({
        observe: async (observation) => {
          const values = await observation.page
            .locator("form input")
            .evaluateAll((inputs) =>
              inputs.map((input) => (input as HTMLInputElement).value),
            );
          assert.equal(
            values.includes(request.name),
            false,
            `unmasked values: ${JSON.stringify(values)}`,
          );
          assert.equal(
            values.includes(request.email),
            false,
            `unmasked values: ${JSON.stringify(values)}`,
          );
          assert.ok(observation.selector?.includes("contact-workflow-ai-scope"));
          assert.doesNotMatch(
            await observation.page.locator("body").innerHTML(),
            /Test User|test@example\.com/,
          );
          return observation.instruction.includes("contact message")
            ? [
                {
                  instruction: "Fill the contact message",
                  selector: "#message-proxy",
                  method: "fill",
                  arguments: ["%message%"],
                },
              ]
            : [];
        },
      });
      const populated = new Set<PopulatedField>(["name", "email"]);
      const result = await populate_contact_form_with_stagehand_fallback(
        intelligence,
        request,
        candidate_for(page, page.locator("form")),
        populated,
        "a message field could not be identified",
      );

      assert.equal(result.resolved, true, result.reason);
      assert.equal(populated.has("message"), true);
      assert.equal(await page.locator("#known-name").inputValue(), request.name);
      assert.equal(await page.locator("#known-email").inputValue(), request.email);
      assert.equal(
        await page.locator("#known-email").getAttribute("value"),
        request.email,
      );
      assert.equal(await page.locator("#hidden-email").inputValue(), request.email);
      assert.equal(await page.locator("#mirrored-email").innerText(), request.email);
      assert.equal(await page.locator("#message-proxy").inputValue(), request.message);
      assert.equal(result.aiActions[0]?.placeholderInstruction.includes(request.email), false);
    },
  );
});

test("page masking restores overlapping and one-character contact values", async () => {
  await with_page(
    `<form>
       <input id="long-value" value="Alpha1">
       <input id="short-value" type="hidden" value="1">
     </form>
     <aside id="mirror">Alpha1 / 1</aside>`,
    async (page) => {
      const scope = await create_page_intelligence_scope(page.locator("form"));
      try {
        await with_masked_page_values(page, ["Alpha1", "1"], async () => {
          assert.equal(await page.locator(scope.selector).count(), 1);
          assert.notEqual(await page.locator("#long-value").inputValue(), "Alpha1");
          assert.notEqual(await page.locator("#short-value").inputValue(), "1");
          assert.notEqual(await page.locator("#mirror").innerText(), "Alpha1 / 1");
        });
      } finally {
        await scope.close();
      }

      assert.equal(await page.locator("#long-value").inputValue(), "Alpha1");
      assert.equal(await page.locator("#long-value").getAttribute("value"), "Alpha1");
      assert.equal(await page.locator("#short-value").inputValue(), "1");
      assert.equal(await page.locator("#short-value").getAttribute("value"), "1");
      assert.equal(await page.locator("#mirror").innerText(), "Alpha1 / 1");
      assert.equal(
        await page.locator("form").getAttribute("data-contact-workflow-ai-scope"),
        null,
      );
    },
  );
});

test("population rejects an action containing literal contact data", async () => {
  await with_page(
    `<form><input id="message-proxy" required value="Hello"></form>`,
    async (page) => {
      const request = contact_request();
      const intelligence = new FakePageIntelligence({
        observe: () => [
          {
            instruction: `Fill ${request.message}`,
            selector: "#message-proxy",
            method: "fill",
            arguments: [request.message],
          },
        ],
      });
      const result = await populate_contact_form_with_stagehand_fallback(
        intelligence,
        request,
        candidate_for(page, page.locator("form")),
        new Set<PopulatedField>(),
        "a message field could not be identified",
      );

      assert.equal(result.resolved, false);
      assert.equal(intelligence.actCalls.length, 0);
      assert.equal(result.aiActions[0]?.acceptance, "rejected");
      assert.doesNotMatch(JSON.stringify(result.aiActions), /Please contact me/);
    },
  );
});

test("population supports an approved company placeholder", async () => {
  await with_page(
    `<form><label>Company <input id="company" name="company"></label></form>`,
    async (page) => {
      const request: ContactRequest = {
        ...contact_request(),
        company: "Aura",
        role: "Sales Manager",
        website: "https://www.aura.com",
        country: "USA",
      };
      const intelligence = new FakePageIntelligence({
        observe: (observation) =>
          observation.instruction.includes("contact company")
            ? [
                {
                  instruction: "Fill the company",
                  selector: "#company",
                  method: "fill",
                  arguments: ["%company%"],
                },
              ]
            : [],
      });
      const populated = new Set<PopulatedField>([
        "name",
        "email",
        "phone",
        "message",
        "role",
        "website",
        "country",
      ]);
      const result = await populate_contact_form_with_stagehand_fallback(
        intelligence,
        request,
        candidate_for(page, page.locator("form")),
        populated,
        "company field could not be identified",
      );

      assert.equal(result.resolved, true, result.reason);
      assert.equal(populated.has("company"), true);
      assert.equal(await page.locator("#company").inputValue(), "Aura");
      assert.equal(result.aiActions[0]?.acceptance, "accepted");
      assert.doesNotMatch(JSON.stringify(result.aiActions), /Aura/);
    },
  );
});

test("population continues after an AI fill injects passive CAPTCHA markup", async () => {
  await with_page(
    `<form><input id="message-proxy" required value="Hello"></form>
     <script>
       document.querySelector('#message-proxy').addEventListener('input', () => {
         const captcha = document.createElement('div');
         captcha.className = 'captcha-challenge';
         document.body.append(captcha);
       });
     </script>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: (request) =>
          request.instruction.includes("contact message")
            ? [
                {
                  instruction: "Fill the contact message",
                  selector: "#message-proxy",
                  method: "fill",
                  arguments: ["%message%"],
                },
              ]
            : [],
      });
      const result = await populate_contact_form_with_stagehand_fallback(
        intelligence,
        contact_request(),
        candidate_for(page, page.locator("form")),
        new Set<PopulatedField>(),
        "a message field could not be identified",
      );

      assert.equal(result.resolved, true);
      assert.doesNotMatch(result.reason, /CAPTCHA/);
      assert.equal(intelligence.observeCalls.length, 4);
      assert.equal(intelligence.actCalls.length, 1);
    },
  );
});

test("passive CAPTCHA markup does not block deterministic population", async () => {
  await with_page(
    `<form><input type="email"><textarea></textarea><div class="g-recaptcha"></div><button>Send</button></form>`,
    async (page) => {
      const intelligence = new FakePageIntelligence();
      const result = await populate_contact_form(
        contact_request(),
        candidate_for(page, page.locator("form")),
        { pageIntelligence: intelligence },
      );

      assert.equal(result.blockingReason, undefined);
      assert.ok(result.populatedFields.includes("message"));
      assert.equal(intelligence.observeCalls.length, 0);
      assert.equal(intelligence.actCalls.length, 0);
    },
  );
});

test("CAPTCHA markup injected by deterministic filling does not create a blocker", async () => {
  await with_page(
    `<form>
       <input type="email" aria-label="Email">
       <textarea aria-label="Message"></textarea>
     </form>
     <script>
       document.querySelector('textarea').addEventListener('input', () => {
         if (!document.querySelector('.captcha-challenge')) {
           const captcha = document.createElement('div');
           captcha.className = 'captcha-challenge';
           document.body.append(captcha);
         }
       });
     </script>`,
    async (page) => {
      const intelligence = new FakePageIntelligence();
      const result = await populate_contact_form(
        contact_request(),
        candidate_for(page, page.locator("form")),
        { pageIntelligence: intelligence },
      );

      assert.equal(result.blockingReason, undefined);
      assert.equal(intelligence.observeCalls.length, 0);
      assert.equal(intelligence.actCalls.length, 0);
    },
  );
});

test("population rescans controls after delayed form rendering", async () => {
  await with_page(
    `<form><input type="email" aria-label="Email"></form>
     <script>setTimeout(() => {
       const message = document.createElement('textarea');
       message.setAttribute('aria-label', 'Message');
       document.querySelector('form').append(message);
     }, 100);</script>`,
    async (page) => {
      const result = await populate_contact_form(
        contact_request(),
        candidate_for(page, page.locator("form")),
      );

      assert.equal(result.blockingReason, undefined);
      assert.ok(result.populatedFields.includes("email"));
      assert.ok(result.populatedFields.includes("message"));
      assert.equal(await page.locator("textarea").inputValue(), contact_request().message);
    },
  );
});

test("Stagehand progression accepts only a Playwright-validated non-submit control", async () => {
  const decoys = Array.from(
    { length: 20 },
    (_, index) => `<button type="button" disabled>Disabled ${index}</button>`,
  ).join("");
  await with_page(
    `<form>
       <h1>Contact our project team</h1>
       <section id="first"><input type="email" name="email">${decoys}<button id="real-next" type="button">Continue</button></section>
       <section id="second" hidden><textarea name="message"></textarea><button type="submit">Send</button></section>
     </form>
     <script>document.querySelector('#real-next').onclick = () => { document.querySelector('#first').hidden = true; document.querySelector('#second').hidden = false; };</script>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: (request) =>
          request.instruction.includes("selected multi-step contact form")
            ? [click_action("#real-next", "Continue")]
            : [],
      });
      const result = await populate_contact_form(
        contact_request(),
        candidate_for(page, page.locator("form")),
        { pageIntelligence: intelligence },
      );

      assert.equal(
        await page.locator("#first").isHidden(),
        true,
        `progression control was not activated: ${result.blockingReason}`,
      );
      assert.equal(await page.locator("#second").isVisible(), true);
      assert.equal(result.blockingReason, undefined, result.blockingReason);
      assert.equal(result.messageDisposition, "populated");
      assert.equal(await page.locator("textarea").inputValue(), contact_request().message);
      assert.equal(result.aiActions?.[0]?.acceptance, "accepted");
      assert.equal(intelligence.actCalls.length, 0);
    },
  );
});

test("Stagehand progression rejects submit-like selectors without clicking", async () => {
  const decoys = Array.from(
    { length: 20 },
    (_, index) => `<button type="button" disabled>Disabled ${index}</button>`,
  ).join("");
  await with_page(
    `<form>
       <h1>Contact our project team</h1>
       <input type="email" name="email">
       ${decoys}
       <button id="real-next" type="button">Continue</button>
       <button id="unsafe" type="submit">Next</button>
     </form>
     <script>window.submitClicks = 0; document.querySelector('form').onsubmit = (event) => { event.preventDefault(); window.submitClicks += 1; };</script>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: (request) =>
          request.instruction.includes("selected multi-step contact form")
            ? [click_action("#unsafe", "Next")]
            : [],
      });
      const result = await populate_contact_form(
        contact_request(),
        candidate_for(page, page.locator("form")),
        { pageIntelligence: intelligence },
      );

      assert.match(result.blockingReason ?? "", /invalid progression selectors/i);
      assert.equal(result.messageDisposition, "notOffered");
      assert.equal(result.aiActions?.[0]?.acceptance, "rejected");
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { submitClicks: number }).submitClicks,
        ),
        0,
      );
    },
  );
});

test("Stagehand may retain a different complete form only as validated locator evidence", async () => {
  const decoys = Array.from(
    { length: 20 },
    (_, index) => `<button type="button" disabled>Disabled ${index}</button>`,
  ).join("");
  await with_page(
    `<form id="incomplete">
       <h1>Contact our project team</h1>
       <input type="email" name="email">${decoys}<button id="real-next" type="button">Continue</button>
     </form>
     <form id="alternative"><h2>Send us a message</h2><textarea name="message"></textarea><button type="submit">Send</button></form>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: (request) =>
          request.instruction.includes("different from the currently selected")
            ? [click_action("#alternative textarea", "Message field")]
            : [],
      });
      const candidate = candidate_for(page, page.locator("#incomplete"));
      const result = await populate_contact_form(
        contact_request(),
        candidate,
        { pageIntelligence: intelligence },
      );

      assert.equal(result.blockingReason, undefined, result.blockingReason);
      assert.equal(result.messageDisposition, "populated");
      assert.equal(await candidate.form.getAttribute("id"), "alternative");
      assert.equal(await page.locator("#alternative textarea").inputValue(), contact_request().message);
      assert.equal(intelligence.actCalls.length, 0);
      assert.equal(
        result.aiActions?.some(
          (action) => action.acceptance === "accepted" && action.result === "succeeded",
        ),
        true,
      );
    },
  );
});

test("submit preflight refuses a control intercepted by a non-cookie overlay", async () => {
  await with_page(
    `<form><input type="email"><textarea></textarea><button id="send">Send</button></form>
     <div style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.1)"></div>
     <script>window.submitClicks = 0; document.querySelector('form').onsubmit = (event) => { event.preventDefault(); window.submitClicks += 1; };</script>`,
    async (page) => {
      const result = await submit_and_assess_contact_form(
        { page, close: async () => undefined },
        candidate_for(page, page.locator("form")),
      );

      assert.equal(result.attempted, false);
      assert.match(result.reason ?? "", /intercepted/);
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { submitClicks: number }).submitClicks,
        ),
        0,
      );
    },
  );
});

test("submission masks populated values and activates exactly one validated control", async () => {
  await with_page(
    `<form>
       <input id="email" value="private@example.com">
       <input id="hidden-email" type="hidden" value="private@example.com">
       <div id="proceed" role="button" tabindex="0">Finish</div>
     </form>
     <aside id="email-copy">private@example.com</aside>
     <script>window.submitClicks = 0; document.querySelector('#proceed').onclick = () => { window.submitClicks += 1; };</script>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: async (observation) => {
          assert.notEqual(
            await observation.page.locator("#email").inputValue(),
            "private@example.com",
            "the visible input value was not masked",
          );
          assert.doesNotMatch(
            await observation.page.locator("body").innerHTML(),
            /private@example\.com/,
          );
          assert.ok(observation.selector?.includes("contact-workflow-ai-scope"));
          return [click_action("#proceed", "Finish")];
        },
      });
      const audit_events: never[] = [];
      const result = await attempt_stagehand_submission_fallback({
        page,
        pageIntelligence: intelligence,
        candidate: candidate_for(page, page.locator("form")),
        buttonAuditEvents: audit_events,
        submissionAlreadyAttempted: false,
        redactionValues: ["private@example.com"],
      });

      assert.equal(result.attempted, true, result.reason);
      assert.equal(result.aiActions[0]?.result, "succeeded");
      assert.equal(await page.locator("#email").inputValue(), "private@example.com");
      assert.equal(
        await page.locator("#email").getAttribute("value"),
        "private@example.com",
      );
      assert.equal(
        await page.locator("#hidden-email").inputValue(),
        "private@example.com",
      );
      assert.equal(await page.locator("#email-copy").innerText(), "private@example.com");
      assert.equal(await page.evaluate(() => (window as unknown as { submitClicks: number }).submitClicks), 1);
      assert.equal(intelligence.actCalls.length, 1);

      const blocked_retry = await attempt_stagehand_submission_fallback({
        page,
        pageIntelligence: intelligence,
        candidate: candidate_for(page, page.locator("form")),
        buttonAuditEvents: audit_events,
        submissionAlreadyAttempted: true,
        redactionValues: ["private@example.com"],
      });
      assert.equal(blocked_retry.attempted, false);
      assert.equal(intelligence.actCalls.length, 1);
    },
  );
});

test("submission AI validates one Hebrew submit control without adding actions", async () => {
  await with_page(
    `<form><div id="send" role="button" tabindex="0">שליחת הודעה</div></form>
     <script>window.submitClicks = 0; document.querySelector('#send').onclick = () => { window.submitClicks += 1; };</script>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: (request) => {
          assert.match(request.instruction, /English, Hebrew/);
          return [click_action("#send", "שליחת הודעה")];
        },
      });
      const result = await attempt_stagehand_submission_fallback({
        page,
        pageIntelligence: intelligence,
        candidate: candidate_for(page, page.locator("form")),
        buttonAuditEvents: [],
        submissionAlreadyAttempted: false,
        redactionValues: [],
      });
      assert.equal(result.attempted, true, result.reason);
      assert.equal(intelligence.observeCalls.length, 1);
      assert.equal(intelligence.actCalls.length, 1);
      assert.equal(
        await page.evaluate(() => (window as unknown as { submitClicks: number }).submitClicks),
        1,
      );
    },
  );
});

test("submission AI ignores CAPTCHA markup and uses a non-CAPTCHA control", async () => {
  await with_page(
    `<form><div class="captcha-challenge"></div><div id="finish" role="button">Finish</div></form>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: () => [click_action("#finish", "Finish")],
      });
      const result = await attempt_stagehand_submission_fallback({
        page,
        pageIntelligence: intelligence,
        candidate: candidate_for(page, page.locator("form")),
        buttonAuditEvents: [],
        submissionAlreadyAttempted: false,
        redactionValues: [],
      });

      assert.equal(result.attempted, true);
      assert.equal(intelligence.observeCalls.length, 1);
      assert.equal(intelligence.actCalls.length, 1);
      assert.ok(intelligence.observeCalls[0]?.ignoreSelectors?.length);
    },
  );
});

test("a persistent AI-selected Continue control sends exactly one POST", async () => {
  await with_page("<main></main>", async (page) => {
    let post_count = 0;
    await page.route("http://local.test/**", async (route) => {
      if (route.request().method() === "POST") {
        post_count += 1;
        await route.fulfill({ status: 204, body: "" });
        return;
      }

      await route.fulfill({
        contentType: "text/html",
        body: `<form>
          <input type="email" value="private@example.com">
          <textarea>Existing request</textarea>
          <button id="continue">Continue</button>
        </form>
        <div id="status" role="status"></div>
        <script>
          document.querySelector('#continue').onclick = (event) => {
            event.preventDefault();
            fetch('/submit', { method: 'POST', body: 'one' });
            document.querySelector('#status').textContent =
              'Thank you. Your message has been received.';
          };
        </script>`,
      });
    });
    await page.goto("http://local.test/contact");

    const intelligence = new FakePageIntelligence({
      observe: (request) =>
        request.stage === "submission"
          ? [click_action("#continue", "Continue")]
          : [],
    });
    const assessment = await submit_and_assess_contact_form(
      {
        page,
        pageIntelligence: intelligence,
        redactionValues: ["private@example.com", "Existing request"],
        close: async () => undefined,
      },
      candidate_for(page, page.locator("form")),
    );

    assert.equal(assessment.confirmed, true, assessment.reason);
    assert.equal(post_count, 1);
    assert.equal(intelligence.actCalls.length, 1);
  });
});

test("submission coordinator uses one AI click and exact AI-visible confirmation", async () => {
  await with_page(
    `<form>
       <input type="email" value="private@example.com">
       <textarea>Existing request text</textarea>
       <div id="finish" role="button" tabindex="0">Finish</div>
     </form>
     <div id="status" role="status"></div>
     <script>window.submitClicks = 0; document.querySelector('#finish').onclick = () => { window.submitClicks += 1; document.querySelector('#status').textContent = 'Your correspondence entered the support queue.'; };</script>`,
    async (page) => {
      const confirmation_text =
        "Your correspondence entered the support queue.";
      const intelligence = new FakePageIntelligence({
        observe: (request) =>
          request.stage === "submission"
            ? [click_action("#finish", "Finish contact request")]
            : [],
        extract: () => ({
          isExplicitSuccess: true,
          confidence: "high",
          evidenceText: confirmation_text,
        }),
      });
      const assessment = await submit_and_assess_contact_form(
        {
          page,
          pageIntelligence: intelligence,
          redactionValues: ["private@example.com", "Existing request text"],
          close: async () => undefined,
        },
        candidate_for(page, page.locator("form")),
      );

      assert.equal(assessment.attempted, true);
      assert.equal(
        assessment.confirmed,
        true,
        assessment.reason,
      );
      assert.equal(assessment.aiActions?.some((action) => action.stage === "submission"), true);
      assert.equal(assessment.aiActions?.some((action) => action.stage === "confirmation"), true);
      assert.equal(await page.evaluate(() => (window as unknown as { submitClicks: number }).submitClicks), 1);
      assert.equal(intelligence.actCalls.length, 1);
      assert.equal(intelligence.extractCalls.length, 1);
    },
  );
});

test("submission coordinator blocks an invalid Stagehand proposal before act", async () => {
  await with_page(
    `<form>
       <input type="email" value="private@example.com">
       <textarea>Existing request text</textarea>
       <select required><option value="">Choose a topic</option></select>
       <button id="hidden-submit" type="submit" style="display:none">Send</button>
     </form>
     <script>
       window.submitClicks = 0;
       document.querySelector('#hidden-submit').onclick = () => {
         window.submitClicks += 1;
       };
     </script>`,
    async (page) => {
      const intelligence = new FakePageIntelligence({
        observe: async (request) => {
          await request.page.locator("#hidden-submit").evaluate((element) => {
            (element as HTMLElement).style.display = "block";
          });
          return [click_action("#hidden-submit", "Send contact request")];
        },
      });
      const assessment = await submit_and_assess_contact_form(
        {
          page,
          pageIntelligence: intelligence,
          redactionValues: ["private@example.com", "Existing request text"],
          close: async () => undefined,
        },
        candidate_for(page, page.locator("form")),
      );

      assert.equal(intelligence.observeCalls.length, 1);
      assert.equal(intelligence.actCalls.length, 0);
      assert.equal(assessment.attempted, false);
      assert.equal(assessment.confirmed, false);
      assert.equal(assessment.validationBlocked, true);
      assert.equal(assessment.failureKind, "submission.validation");
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { submitClicks: number }).submitClicks,
        ),
        0,
      );
    },
  );
});

test("deterministic submit and confirmation never invoke PageIntelligence", async () => {
  await with_page(
    `<form><button type="submit">Send</button></form>
     <div id="status"></div>
     <script>
       document.querySelector('form').onsubmit = (event) => {
         event.preventDefault();
         document.querySelector('#status').textContent =
           'Thank you. Your message has been received.';
       };
     </script>`,
    async (page) => {
      const intelligence = new FakePageIntelligence();
      const assessment = await submit_and_assess_contact_form(
        {
          page,
          pageIntelligence: intelligence,
          close: async () => undefined,
        },
        candidate_for(page, page.locator("form")),
      );

      assert.equal(assessment.confirmed, true, assessment.reason);
      assert.equal(intelligence.observeCalls.length, 0);
      assert.equal(intelligence.actCalls.length, 0);
      assert.equal(intelligence.extractCalls.length, 0);
    },
  );
});

test("population handoff rebinds a rerendered form and repopulates once", async () => {
  await with_page(
    `<form id="contact">
       <input name="name"><input type="email" name="email"><textarea name="message"></textarea>
       <button type="submit">Send</button>
     </form>
     <div id="status"></div>
     <script>
       window.submitClicks = 0;
       document.addEventListener('submit', (event) => {
         if (!event.target || event.target.id !== 'contact') return;
         event.preventDefault();
         window.submitClicks += 1;
         document.querySelector('#contact').reset();
         document.querySelector('#status').textContent = 'Thank you, your message was sent.';
       });
     </script>`,
    async (page) => {
      const candidate = candidate_for(page, page.locator("#contact"));
      const population = await populate_contact_form(
        contact_request(),
        candidate,
      );
      assert.equal(population.blockingReason, undefined, population.blockingReason);
      assert.ok(population.submissionHandoff);

      await page.locator("#contact").evaluate((form) => {
        const replacement = form.cloneNode(true) as HTMLFormElement;
        replacement.querySelectorAll("input, textarea").forEach((control) => {
          (control as HTMLInputElement | HTMLTextAreaElement).value = "";
        });
        form.replaceWith(replacement);
      });

      const assessment = await submit_and_assess_contact_form(
        { page, close: async () => undefined },
        candidate,
        {
          contactRequest: contact_request(),
          populationHandoff: population.submissionHandoff,
        },
      );

      assert.equal(
        assessment.confirmed,
        true,
        `${assessment.reason}; clicks=${await page.evaluate(() => (window as unknown as { submitClicks: number }).submitClicks)}; status=${await page.locator("#status").innerText()}`,
      );
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { submitClicks: number }).submitClicks,
        ),
        1,
      );
    },
  );
});

test("post-submit form reset with explicit confirmation is not validation failure", async () => {
  await with_page(
    `<form id="contact">
       <input type="email" name="email"><textarea name="message"></textarea>
       <button type="submit">Send</button>
     </form>
     <div id="status"></div>
     <script>
       document.querySelector('#contact').onsubmit = (event) => {
         event.preventDefault();
         document.querySelector('#contact').reset();
         document.querySelector('#status').textContent = 'Your message has been sent.';
       };
     </script>`,
    async (page) => {
      const assessment = await submit_and_assess_contact_form(
        { page, close: async () => undefined },
        candidate_for(page, page.locator("#contact")),
      );

      assert.equal(assessment.confirmed, true, assessment.reason);
      assert.equal(assessment.validationBlocked, false);
    },
  );
});

test("confirmation accepts only exact newly visible text and redacts echoed contact data", async () => {
  await with_page(`<main>Contact page</main>`, async (page) => {
    const safe_message =
      "Request for [redacted contact value] entered the support queue.";
    let extraction_value: unknown = {
      isExplicitSuccess: true,
      confidence: "high",
      evidenceText: safe_message,
    };
    const intelligence = new FakePageIntelligence({
      extract: async (request) => {
        const scoped_text = await request.page.locator(request.selector ?? "body").innerText();
        assert.doesNotMatch(scoped_text, /private@example\.com/);
        return extraction_value;
      },
    });
    const result = await classify_stagehand_submission_confirmation({
      pageIntelligence: intelligence,
      page,
      messagesBeforeSubmission: [],
      messagesAfterSubmission: [
        {
          selector: ".message",
          text: "Request for private@example.com entered the support queue.",
          frameUrl: page.url(),
        },
      ],
      redactionValues: ["private@example.com"],
    });

    assert.equal(result.evidence, "aiVisibleText", result.reason);
    assert.equal(result.evidenceText, safe_message);
    assert.equal(
      await page.locator('[id^="contact-workflow-ai-confirmation-"]').count(),
      0,
    );

    extraction_value = {
      isExplicitSuccess: true,
      confidence: "high",
      evidenceText: "A success message that is not on the page",
    };
    const rejected = await classify_stagehand_submission_confirmation({
      pageIntelligence: intelligence,
      page,
      messagesBeforeSubmission: [],
      messagesAfterSubmission: [
        {
          selector: ".message",
          text: "Request entered the support queue.",
          frameUrl: page.url(),
        },
      ],
      redactionValues: [],
    });
    assert.equal(rejected.evidence, "none");
    assert.equal(rejected.aiActions[0]?.acceptance, "rejected");
  });
});

test("confirmation rejects generic thanks even when classified high confidence", async () => {
  await with_page(`<main>Contact page</main>`, async (page) => {
    const intelligence = new FakePageIntelligence({
      extract: () => ({
        isExplicitSuccess: true,
        confidence: "high",
        evidenceText: "Thank you",
      }),
    });
    const result = await classify_stagehand_submission_confirmation({
      pageIntelligence: intelligence,
      page,
      messagesBeforeSubmission: [],
      messagesAfterSubmission: [
        { selector: ".message", text: "Thank you", frameUrl: page.url() },
      ],
      redactionValues: [],
    });

    assert.equal(result.evidence, "none");
    assert.match(result.reason, /lacked explicit submission-success language/);
  });
});

test("confirmation rejects negated submission language", async () => {
  await with_page(`<main>Contact page</main>`, async (page) => {
    const failure_text = "Your message was not sent.";
    const intelligence = new FakePageIntelligence({
      extract: () => ({
        isExplicitSuccess: true,
        confidence: "high",
        evidenceText: failure_text,
      }),
    });
    const result = await classify_stagehand_submission_confirmation({
      pageIntelligence: intelligence,
      page,
      messagesBeforeSubmission: [],
      messagesAfterSubmission: [
        { selector: ".error", text: failure_text, frameUrl: page.url() },
      ],
      redactionValues: [],
    });

    assert.equal(result.evidence, "none");
    assert.match(result.reason, /lacked explicit submission-success language/);
  });
});

test("confirmation AI ignores CAPTCHA markup and verifies new success text", async () => {
  await with_page(`<div class="captcha-challenge"></div>`, async (page) => {
    const intelligence = new FakePageIntelligence({
      extract: () => ({
        isExplicitSuccess: true,
        confidence: "high",
        evidenceText: "Your message was received",
      }),
    });
    const result = await classify_stagehand_submission_confirmation({
      pageIntelligence: intelligence,
      page,
      messagesBeforeSubmission: [],
      messagesAfterSubmission: [
        {
          selector: ".message",
          text: "Your message was received",
          frameUrl: page.url(),
        },
      ],
      redactionValues: [],
    });

    assert.equal(result.evidence, "aiVisibleText");
    assert.equal(intelligence.extractCalls.length, 1);
    assert.ok(intelligence.extractCalls[0]?.ignoreSelectors?.length);
  });
});

test("confirmation remains evidence-based when CAPTCHA appears during extraction", async () => {
  await with_page(`<main>Contact page</main>`, async (page) => {
    const intelligence = new FakePageIntelligence({
      extract: async (request) => {
        await request.page.evaluate(() => {
          const captcha = document.createElement("div");
          captcha.className = "captcha-challenge";
          document.body.append(captcha);
        });
        return {
          isExplicitSuccess: true,
          confidence: "high",
          evidenceText: "Your message was received",
        };
      },
    });
    const result = await classify_stagehand_submission_confirmation({
      pageIntelligence: intelligence,
      page,
      messagesBeforeSubmission: [],
      messagesAfterSubmission: [
        {
          selector: ".message",
          text: "Your message was received",
          frameUrl: page.url(),
        },
      ],
      redactionValues: [],
    });

    assert.equal(result.evidence, "aiVisibleText");
    assert.equal(intelligence.extractCalls.length, 1);
  });
});

interface FakePageIntelligenceOptions {
  observe?: (
    request: PageIntelligenceObserveRequest,
  ) => PageIntelligenceAction[] | Promise<PageIntelligenceAction[]>;
  extract?: (
    request: PageIntelligenceExtractRequest<unknown>,
  ) => unknown | Promise<unknown>;
}

class FakePageIntelligence implements PageIntelligence {
  readonly model = "test/structured-model";
  readonly observeCalls: PageIntelligenceObserveRequest[] = [];
  readonly actCalls: PageIntelligenceActRequest[] = [];
  readonly extractCalls: PageIntelligenceExtractRequest<unknown>[] = [];
  extractValue: unknown;

  constructor(private readonly options: FakePageIntelligenceOptions = {}) {}

  async observe(
    request: PageIntelligenceObserveRequest,
  ): Promise<PageIntelligenceObserveResult> {
    this.observeCalls.push(request);
    const actions = (await this.options.observe?.(request)) ?? [];
    return { actions, model: this.model, durationMs: 1 };
  }

  async act(
    request: PageIntelligenceActRequest,
  ): Promise<PageIntelligenceActResult> {
    this.actCalls.push(request);
    const locator = request.page.locator(request.action.selector);
    if (request.action.method === "click") {
      await locator.click();
    } else if (request.action.method === "fill") {
      const argument = request.action.arguments?.[0] ?? "";
      const variable_name = argument.match(/^%([a-z]+)%$/)?.[1] as
        | PageIntelligenceVariableName
        | undefined;
      const value = variable_name ? request.variables?.[variable_name] : undefined;
      if (!value) {
        throw new Error("Fake fill action did not receive an approved variable");
      }
      await locator.fill(value);
    } else {
      throw new Error(`Unsupported fake action: ${request.action.method}`);
    }

    return {
      success: true,
      message: "completed",
      actionDescription: request.action.instruction,
      actions: [request.action],
      model: this.model,
      durationMs: 1,
    };
  }

  async extract<T>(
    request: PageIntelligenceExtractRequest<T>,
  ): Promise<PageIntelligenceExtractResult<T>> {
    this.extractCalls.push(
      request as unknown as PageIntelligenceExtractRequest<unknown>,
    );
    const raw_value = this.options.extract
      ? await this.options.extract(
          request as unknown as PageIntelligenceExtractRequest<unknown>,
        )
      : this.extractValue;
    return {
      data: request.schema.parse(raw_value),
      model: this.model,
      durationMs: 1,
    };
  }
}

async function with_page(
  html: string,
  callback: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.setContent(html);
    await callback(page);
  } finally {
    await context.close();
  }
}

function candidate_for(page: Page, form: ReturnType<Page["locator"]>): ContactFormCandidate {
  return {
    form,
    frame: page.mainFrame(),
    score: 10,
    source: "generic",
    structure: "nativeForm",
  };
}

function contact_request(): ContactRequest {
  return {
    websiteUrl: "http://local.test/contact",
    name: "Test User",
    email: "test@example.com",
    phone: "050-0000000",
    message: "Please contact me about the project.",
  };
}

function click_action(selector: string, instruction: string): PageIntelligenceAction {
  return { selector, instruction, method: "click", arguments: [] };
}
