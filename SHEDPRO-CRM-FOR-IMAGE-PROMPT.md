# ShedPro CRM — description for generating a dashboard mockup

Paste the whole of this into ChatGPT (or any image model) and ask for a
dashboard mockup. Everything below is what the CRM actually is today.

---

## 1. What ShedPro is

ShedPro is a custom shed builder in Utah. Customers design a shed in a 3D
configurator on the website, which produces a priced quote. The CRM is the
back office the shop runs the business from: leads, quotes, scheduling,
invoicing and now a customer-facing build tracker.

It is used by a very small team, heavily on a phone, often standing in a yard
or a driveway. Nobody sits at a desk with it.

## 2. Pages that exist today

The CRM is five pages, reached from one nav menu:

1. **Customers** (the landing page) — one table, newest activity first.
   Columns: Last Activity, Name, Email, Phone, Latest Quote, Status,
   Latest Note. New leads are highlighted with an orange left edge and a faint
   orange gradient across the row. Each customer carries a coloured
   "temperature" chip — Hot, Warm, Cold, Dormant — derived from how long since
   their last activity, and overridable by hand.

2. **Schedule** — a month calendar grid (six weeks of cells, Sunday first),
   plus list views: Next 7 days, Everything, Past. Each booked job shows a
   coloured stage tag, the customer's name, the build summary, the address, any
   note, and a row of actions: Call, Text, Map, Invite (adds it to Google
   Calendar), and Mark done.

3. **Activity** — a reverse-chronological feed of everything that happened:
   new orders, consult requests, designs saved, payments logged, invoices sent.
   Filterable by kind. The nav carries an unread count badge.

4. **Data** — the analytics page. Four KPI tiles across the top:
   Total Submissions, Total Customers, Avg Quoted Price, Median Quoted Price.
   Then sections for: Won Projects (Jobs Won, Won Revenue, Gross Profit,
   Collected, plus "what wins / what loses" bar lists); Delivery (Awaiting a
   Date, Scheduled, Installed — each with revenue); a Status Funnel; a
   60-day submissions chart; "How They Heard About Us"; a map of where
   submissions come from; and design preferences (shed style, siding,
   popular sizes).

5. **Pricing** — editable price tables: base price by size per shed style,
   and add-on components.

**Customer detail page** (opened from the Customers table): contact fields,
lead temperature and a revisit date, Order History (each order with its price,
status dropdown, quote button, adjustments, invoicing, install bookings and a
build planner), Call Log, Notes, Payments.

## 3. The data the CRM holds

- **Customers** — name, email, phone, street address, city, state, ZIP, date
  added, lead temperature, follow-up date.
- **Submissions (orders)** — the full 3D build config, quoted price, discounts
  and surcharges, effective price, status, date won. Status moves through:
  new -> contacted -> quoted -> won / lost.
- **Installs** — one row per stage of a build, each with a date, a length in
  days, a note, and whether it has been ticked off as done. Stages are:
  Site prep, Concrete pour or Gravel pad, Materials, Shop build, Shed install.
- **Notes**, **Call log** (outcomes: Connected, Left voicemail, No answer,
  Callback requested, Wrong number), **Payments**, **Invoices** (deposit and
  balance, through Stripe).

## 4. What a dashboard would need to answer

The CRM currently has no dashboard. These are the questions the shop actually
asks, in rough priority order:

- What is happening today and this week? (jobs on site, in the shop, deliveries)
- Who needs calling back today? (follow-ups due, new leads untouched)
- What is sold but has no date yet? (money waiting on scheduling)
- What has been invoiced and not paid?
- How much has been won this month, and what is the margin?
- What is in the pipeline, and where is it stuck?

## 5. The existing visual identity — IMPORTANT, match this

The CRM is dark, narrow and typographic. Not a generic light-mode SaaS
dashboard.

**Colours (exact):**
- Page background near-black: `#040407`
- Card / panel background: `#08080f`
- Hairline borders and dividers: `#2a2d38`
- Body text, light grey: `#c8cdd6`
- Muted / secondary text: `#8a909e`
- Headings, brightest white: `#e8ecf4`
- Primary accent, electric cyan-blue: `#2cc0fd`
- Secondary accent, orange: `#f6941f`
- Success / finished, green: `#3ddc97`

**Type:**
- Brand wordmark and headers: **Syncopate**, wide letterspacing, uppercase
- Numbers, labels, buttons, table headers: **DM Mono**, 10-11px, uppercase,
  heavy letterspacing (0.15em-0.4em)
- Body copy and large figures: **Cormorant Garamond**, a light serif,
  weight 300

**Style rules it follows:**
- Flat. No drop shadows, no rounded corners, no gradients except one hairline
  gradient rule (blue to orange) under the page header.
- Everything is boxed in 1px hairline borders, never cards with shadows.
- Tiny uppercase monospace labels sit above large light-serif values.
- Section headers are a tiny letterspaced monospace eyebrow label above a
  serif heading. Example: "WON PROJECTS" above "What You've Closed".
- Buttons are outline-only rectangles with uppercase monospace labels. The
  primary action is solid cyan with black text.
- Status colours: cyan for scheduled/active, orange for new/attention,
  green for done/paid, muted grey for dormant.
- Header is a small ShedPro logo, "SHEDPRO ADMIN" in Syncopate, and a
  subtitle "Built & managed by Potentia".

## 6. Suggested prompt to finish with

"Design a dashboard home screen for this CRM. Dark, flat, typographic, using
the exact colours and fonts above. Show a top row of KPI tiles, a 'today and
this week' schedule panel, a 'needs attention' list of follow-ups and untouched
leads, a money panel (won this month, unpaid invoices, sold with no date yet),
and a compact pipeline funnel. Desktop width, but show how it stacks on a
phone. No rounded corners, no shadows, hairline borders only."
