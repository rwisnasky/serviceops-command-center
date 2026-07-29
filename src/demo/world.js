/**
 * src/demo/world.js
 *
 * Builds the entire fake ServiceTitan tenant in memory, once, at boot.
 *
 * Design notes
 * ------------
 * - **Deterministic.** Everything derives from the seeded RNG in ./rng.js, so
 *   the same seed always produces the same company. Screenshots stay valid.
 *
 * - **Anchored to "now", not to a fixed date.** Jobs are laid down relative to
 *   the boot timestamp and spread across the previous 15 months. A demo that
 *   hardcodes 2026 dates looks abandoned by 2028; this one never goes stale.
 *
 * - **Internally consistent.** A job points at a real customer, at a real
 *   location owned by that customer, has appointments assigned to a technician
 *   whose trade matches the job type, and (usually) an invoice whose line items
 *   come from the pricebook and whose total roughly matches the job type's
 *   average ticket. The reports downstream do real arithmetic on this data, so
 *   incoherent fixtures would surface immediately as nonsense margins.
 *
 * - **Deliberately imperfect.** Real operational data has warts, and the whole
 *   point of several pages in this app is to *find* those warts. So the
 *   generator plants them on purpose: completed jobs with no invoice, jobs with
 *   three appointments, addresses that fail geocode validation, calls the AI
 *   mislabels, installs missing their warranty registration. See PLANTED
 *   DEFECTS at the bottom of this file for the full list.
 */

const { Rng, ROOT_SEED } = require("./rng");
const C = require("./catalog");

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

const iso = (d) => new Date(d).toISOString();
const dateOnly = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d).getTime() + n * DAY_MS);
const addHours = (d, n) => new Date(new Date(d).getTime() + n * 3600000);

/** Seasonal demand multiplier: HVAC spikes in July/August and Dec/Jan. */
function seasonalWeight(month, category) {
  // month is 1-12
  const cooling = [0.5, 0.5, 0.7, 0.9, 1.3, 1.7, 2.0, 1.9, 1.2, 0.8, 0.6, 0.5];
  const heating = [1.9, 1.6, 1.1, 0.8, 0.6, 0.5, 0.5, 0.5, 0.7, 1.1, 1.6, 2.0];
  const flat = new Array(12).fill(1);
  if (category === "cooling") return cooling[month - 1];
  if (category === "heating") return heating[month - 1];
  return flat[month - 1];
}

function jobTypeSeason(jt) {
  const n = jt.name.toLowerCase();
  if (/(ac |cool|condenser|air handler|mini split)/.test(n)) return "cooling";
  if (/(furnace|heat|boiler)/.test(n)) return "heating";
  return "flat";
}

// ---------------------------------------------------------------------------
// Primitive generators
// ---------------------------------------------------------------------------

/**
 * Every generated phone lives in the 555-01XX block that NANP reserves for
 * fiction. There is no way for a demo number to reach a real line.
 */
function makePhone(rng) {
  const area = rng.pick(["614", "330", "937", "740", "419"]);
  const line = String(rng.int(100, 199));
  return `(${area}) 555-0${line}`;
}

function makeStreet(rng) {
  const num = rng.weighted([
    [rng.int(100, 999), 5],
    [rng.int(1000, 9999), 4],
    [rng.int(10000, 14999), 1],
  ]);
  return `${num} ${rng.pick(C.STREET_NAMES)} ${rng.pick(C.STREET_SUFFIXES)}`;
}

function makeAddress(rng, opts = {}) {
  const city = rng.weighted(C.CITIES.map((c) => [c, c.weight]));
  const addr = {
    street: makeStreet(rng),
    unit: rng.chance(0.12) ? `${rng.pick(C.UNIT_PREFIXES)} ${rng.int(1, 24)}${rng.chance(0.4) ? rng.pick(["A", "B", "C"]) : ""}` : "",
    city: city.name,
    state: C.STATE,
    zip: city.zip,
    country: "USA",
  };
  // A slice of addresses are deliberately messy so the Address Audit page has
  // something to find: abbreviation drift, missing directionals, bad ZIPs.
  if (opts.messy) {
    const kind = rng.int(0, 3);
    if (kind === 0) addr.street = addr.street.replace(/\bSt$/, "Street").replace(/\bRd$/, "Road").replace(/\bDr$/, "Drive");
    if (kind === 1) addr.street = `${addr.street.split(" ")[0]} ${rng.pick(["N", "S", "E", "W"])} ${addr.street.split(" ").slice(1).join(" ")}`;
    if (kind === 2) addr.zip = String(Number(addr.zip) + rng.int(1, 3));
    if (kind === 3) addr.street = addr.street.toUpperCase();
  }
  return addr;
}

function makePersonName(rng) {
  const first = rng.chance(0.5) ? rng.pick(C.FIRST_NAMES_M) : rng.pick(C.FIRST_NAMES_F);
  return `${first} ${rng.pick(C.LAST_NAMES)}`;
}

function makeBusinessName(rng) {
  return `${rng.pick(C.BUSINESS_NAME_PARTS.prefix)} ${rng.pick(C.BUSINESS_NAME_PARTS.core)}`;
}

function emailFor(name, domain) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .trim()
      .replace(/\s+/g, ".") + "@" + domain
  );
}

// ---------------------------------------------------------------------------
// World builder
// ---------------------------------------------------------------------------

function buildWorld() {
  const t0 = Date.now();
  const NOW = new Date();
  const world = {
    seed: ROOT_SEED,
    builtAt: iso(NOW),
    now: NOW,
    company: C.COMPANY,
  };

  // -------------------------------------------------------------------------
  // Reference data (fixed)
  // -------------------------------------------------------------------------
  world.businessUnits = C.BUSINESS_UNITS.map((b) => ({ ...b }));
  world.jobTypes = C.JOB_TYPES.map((t) => ({ ...t, active: true }));
  world.campaigns = C.CAMPAIGNS.map((c) => ({ ...c }));
  world.callReasons = C.CALL_REASONS.map((r) => ({ ...r, active: true }));

  const rngStaff = new Rng(ROOT_SEED).fork("staff");

  world.technicians = C.TECHNICIANS.map((t) => ({
    id: t.id,
    name: t.name,
    firstName: t.name.split(" ")[0],
    lastName: t.name.split(" ").slice(1).join(" "),
    email: emailFor(t.name, C.COMPANY.emailDomain),
    phoneNumber: makePhone(rngStaff),
    active: true,
    role: t.role,
    roleId: t.role === "Apprentice" ? 3 : 2,
    businessUnitId: t.trade === "Plumbing" ? 2002 : t.trade === "Install" ? 2003 : 2001,
    // demo-only metadata used by the generator and the fleet page
    _trade: t.trade,
    _truck: t.truck,
    _laborRate: t.laborRate,
    _seniority: t.seniority,
  }));

  world.office = C.OFFICE_TEAM.map((o) => ({
    id: o.id,
    name: o.name,
    firstName: o.name.split(" ")[0],
    lastName: o.name.split(" ").slice(1).join(" "),
    email: emailFor(o.name, C.COMPANY.emailDomain),
    phoneNumber: makePhone(rngStaff),
    active: true,
    role: o.role,
    roleId: 4,
    _csr: o.csr,
  }));

  world.owners = C.OWNERS.map((o) => ({
    id: o.id,
    name: o.name,
    firstName: o.name.split(" ")[0],
    lastName: o.name.split(" ").slice(1).join(" "),
    email: emailFor(o.name, C.COMPANY.emailDomain),
    phoneNumber: makePhone(rngStaff),
    active: true,
    role: o.role,
    roleId: 1,
  }));

  /** Everyone ServiceTitan would return from /settings/v2/employees. */
  world.employees = [...world.owners, ...world.office, ...world.technicians];

  world.vendors = C.VENDORS.map((v) => ({
    ...v,
    address: makeAddress(rngStaff),
    phoneNumber: makePhone(rngStaff),
  }));

  // -------------------------------------------------------------------------
  // Pricebook
  // -------------------------------------------------------------------------
  const rngPb = new Rng(ROOT_SEED).fork("pricebook");
  let pbId = 600000;
  const pricebook = { services: [], materials: [], equipment: [], discountsAndFees: [] };

  /**
   * The catalog's fourth column means different things per bucket, which is
   * exactly how a real pricebook is set up:
   *   - services:  it's the MEMBER price (members get ~20% off labor). A service
   *                line's true cost is a small parts/consumables burden; the
   *                technician's time is accounted for separately in payroll.
   *   - materials
   *     equipment: it's the actual replacement COST from the supply house.
   *   - fees:      no cost at all.
   *
   * Getting this wrong is not cosmetic — every gross-margin figure in the app
   * derives from these numbers, and treating a member price as a cost puts the
   * whole company at a ~5% margin.
   */
  const SERVICE_MATERIAL_BURDEN = 0.15;

  const pbItem = (row, skuType, extra = {}) => {
    const [name, code, price, fourth] = row;

    let cost;
    let memberPrice;
    if (skuType === "Service") {
      memberPrice = fourth;
      cost = Math.round(price * SERVICE_MATERIAL_BURDEN * 100) / 100;
    } else if (skuType === "Discount") {
      memberPrice = price;
      cost = 0;
    } else {
      cost = fourth;
      memberPrice = Math.round(price * 0.9 * 100) / 100;
    }

    return {
      id: pbId++,
      code,
      sku: code,
      displayName: name,
      name,
      description: `${name}. Includes standard labor and workmanship warranty.`,
      active: true,
      price,
      memberPrice,
      addOnPrice: price,
      amount: price,
      unitPrice: price,
      cost,
      skuType,
      image: null,
      images: [],
      ...extra,
    };
  };

  C.PRICEBOOK_SERVICES.forEach((r) => pricebook.services.push(pbItem(r, "Service")));
  C.PRICEBOOK_MATERIALS.forEach((r) =>
    pricebook.materials.push(
      pbItem(r, "Material", {
        manufacturer: rngPb.pick(["Universal", "OEM", "Supco", "Honeywell", "Rheem", "Nibco", "Uponor"]),
        primaryVendor: { vendorId: rngPb.pick(C.VENDORS).id },
      })
    )
  );
  C.PRICEBOOK_EQUIPMENT.forEach((r) => {
    const isWh = /water heater|tankless/i.test(r[0]);
    const pool = isWh ? C.EQUIPMENT_MANUFACTURERS.waterHeater : C.EQUIPMENT_MANUFACTURERS.hvac;
    const mfg = rngPb.pick(pool);
    pricebook.equipment.push(
      pbItem(r, "Equipment", {
        manufacturer: mfg.name,
        model: rngPb.pick(mfg.models),
        modelNumber: rngPb.pick(mfg.models),
        primaryVendor: { vendorId: rngPb.pick(C.VENDORS).id },
        otherVendors: [],
        vendors: [],
      })
    );
  });
  C.PRICEBOOK_FEES.forEach((r) => pricebook.discountsAndFees.push(pbItem(r, "Discount")));

  // A handful of planted duplicate SKUs, so the pricebook merge tool has real
  // work to do instead of an empty queue.
  const dupSources = rngPb.sample(pricebook.materials, 6);
  dupSources.forEach((src) => {
    pricebook.materials.push({
      ...src,
      id: pbId++,
      code: `${src.code}-OLD`,
      sku: `${src.code}-OLD`,
      displayName: src.displayName.replace(/\b(\w+)$/, (m) => m.toUpperCase()),
      name: src.displayName + " (legacy)",
      price: Math.round(src.price * 0.92 * 100) / 100,
      _duplicateOf: src.id,
    });
  });

  world.pricebook = pricebook;
  world.pricebookAll = [
    ...pricebook.services,
    ...pricebook.materials,
    ...pricebook.equipment,
    ...pricebook.discountsAndFees,
  ];

  // -------------------------------------------------------------------------
  // Customers, contacts, locations
  // -------------------------------------------------------------------------
  const rngCust = new Rng(ROOT_SEED).fork("customers");
  const CUSTOMER_COUNT = 480;

  world.customers = [];
  world.contacts = [];
  world.locations = [];

  let custId = 100000;
  let locId = 200000;
  let contactId = 150000;

  for (let i = 0; i < CUSTOMER_COUNT; i++) {
    const isCommercial = rngCust.chance(0.14);
    const name = isCommercial ? makeBusinessName(rngCust) : makePersonName(rngCust);
    // ~9% of addresses are deliberately messy — that is the Address Audit page's
    // entire reason for existing.
    const messy = rngCust.chance(0.09);
    const address = makeAddress(rngCust, { messy });

    const cust = {
      id: custId++,
      name,
      type: isCommercial ? "Commercial" : "Residential",
      balance: rngCust.chance(0.08) ? rngCust.money(50, 2400) : 0,
      email: rngCust.chance(0.82) ? emailFor(name, rngCust.pick(["example.com", "example.net", "example.org"])) : null,
      active: true,
      doNotMail: false,
      address,
      createdOn: iso(addDays(NOW, -rngCust.int(30, 2600))),
      _messyAddress: messy,
      _commercial: isCommercial,
    };
    world.customers.push(cust);

    // Contacts: a primary phone, often a mobile, sometimes an email.
    const primary = makePhone(rngCust);
    world.contacts.push({ id: contactId++, customerId: cust.id, type: "Phone", value: primary });
    if (rngCust.chance(0.55)) {
      world.contacts.push({ id: contactId++, customerId: cust.id, type: "MobilePhone", value: makePhone(rngCust) });
    }
    if (cust.email) {
      world.contacts.push({ id: contactId++, customerId: cust.id, type: "Email", value: cust.email });
    }
    cust._primaryPhone = primary;

    // Locations: usually one, occasionally several (landlords, commercial).
    const locCount = isCommercial ? rngCust.weighted([[1, 6], [2, 3], [3, 2], [5, 1]]) : rngCust.weighted([[1, 18], [2, 1]]);
    for (let L = 0; L < locCount; L++) {
      const locAddress = L === 0 ? address : makeAddress(rngCust, { messy: rngCust.chance(0.09) });
      world.locations.push({
        id: locId++,
        name: L === 0 ? name : `${name} - ${locAddress.street}`,
        customerId: cust.id,
        active: true,
        address: locAddress,
        createdOn: cust.createdOn,
      });
    }
  }

  const locationsByCustomer = new Map();
  world.locations.forEach((l) => {
    if (!locationsByCustomer.has(l.customerId)) locationsByCustomer.set(l.customerId, []);
    locationsByCustomer.get(l.customerId).push(l);
  });

  // -------------------------------------------------------------------------
  // Jobs, appointments, invoices, payroll
  // -------------------------------------------------------------------------
  const rngJob = new Rng(ROOT_SEED).fork("jobs");

  const MONTHS_BACK = 15;
  const windowStart = new Date(NOW.getTime() - MONTHS_BACK * 30.4 * DAY_MS);

  world.jobs = [];
  world.appointments = [];
  world.invoices = [];
  world.payments = [];
  world.purchaseOrders = [];
  world.laborSplits = [];
  world.jobTimesheets = [];
  world.grossPayItems = [];
  world.installedEquipment = [];
  world.memberships = [];
  world.recurringServices = [];
  world.estimates = [];
  world.jobNotes = [];
  world.customerNotes = [];
  world.attachments = [];

  let jobId = 300000;
  let jobNumberSeq = 41200;
  let apptId = 400000;
  let invId = 500000;
  let payId = 550000;
  let poId = 900000;
  let eqId = 800000;
  let memId = 850000;
  let recSvcId = 860000;

  // Build a weighted job-type picker per season.
  const pickJobType = (month) =>
    rngJob.weighted(
      world.jobTypes.map((jt) => [jt, jt.weight * seasonalWeight(month, jobTypeSeason(jt))])
    );

  const techsByTrade = {
    HVAC: world.technicians.filter((t) => t._trade === "HVAC"),
    Plumbing: world.technicians.filter((t) => t._trade === "Plumbing"),
    Install: world.technicians.filter((t) => t._trade === "Install"),
  };

  const techForJobType = (jt) => {
    if (jt.category === "Install") return rngJob.pick([...techsByTrade.Install, ...techsByTrade.HVAC.slice(0, 2)]);
    if (jt.bu === 2002 || jt.bu === 2004) return rngJob.pick(techsByTrade.Plumbing);
    return rngJob.pick(techsByTrade.HVAC);
  };

  // The board runs three weeks out, so generate past work *and* the scheduled
  // future — otherwise dispatch, the scoreboard and the calendar are empty.
  const windowEnd = addDays(NOW, 21);

  // ~6 jobs/day on weekdays, ~1.5 on Saturdays, rare Sundays.
  for (let d = new Date(windowStart); d <= windowEnd; d = addDays(d, 1)) {
    const dow = d.getDay();
    const month = d.getMonth() + 1;
    const seasonBoost = (seasonalWeight(month, "cooling") + seasonalWeight(month, "heating")) / 2;
    let count;
    // Twelve technicians running roughly one and a half to two calls each per
    // day, plus install crews. Sundays are emergency-only.
    if (dow === 0) count = rngJob.chance(0.35) ? rngJob.int(1, 2) : 0;
    else if (dow === 6) count = rngJob.int(1, 6);
    else count = Math.max(2, Math.round(rngJob.gaussianClamped(13 * seasonBoost, 3.4, 3, 26)));

    for (let k = 0; k < count; k++) {
      const jt = pickJobType(month);
      const cust = rngJob.pick(world.customers);
      const locs = locationsByCustomer.get(cust.id) || [];
      const loc = rngJob.pick(locs);
      if (!loc) continue;

      const startHour = rngJob.weighted([[8, 4], [9, 5], [10, 5], [11, 4], [12, 3], [13, 5], [14, 5], [15, 4], [16, 3], [17, 1], [19, 1]]);
      const start = new Date(d);
      start.setHours(startHour, rngJob.pick([0, 15, 30, 45]), 0, 0);

      const isFuture = start > NOW;
      const daysAgo = (NOW - start) / DAY_MS;

      // Status: recent work is more likely still open.
      let status;
      if (isFuture) status = rngJob.weighted([["Scheduled", 8], ["Dispatched", 1]]);
      else if (daysAgo < 1) status = rngJob.weighted([["InProgress", 3], ["Dispatched", 2], ["Completed", 4], ["Hold", 1]]);
      else if (daysAgo < 5) status = rngJob.weighted([["Completed", 12], ["InProgress", 1], ["Hold", 2], ["Canceled", 1]]);
      else status = rngJob.weighted([["Completed", 40], ["Canceled", 2], ["Hold", 1]]);

      const tech = techForJobType(jt);
      const completedOn = status === "Completed" ? iso(addHours(start, jt.hours + rngJob.money(-0.4, 1.2))) : null;

      const job = {
        id: jobId++,
        jobNumber: String(jobNumberSeq++),
        jobStatus: status,
        status,
        customerId: cust.id,
        locationId: loc.id,
        jobTypeId: jt.id,
        jobTypeName: jt.name,
        businessUnitId: jt.bu,
        businessUnitName: (world.businessUnits.find((b) => b.id === jt.bu) || {}).name,
        campaignId: rngJob.pick(world.campaigns).id,
        priority: rngJob.weighted([["Normal", 8], ["High", 2], ["Urgent", 1], ["Low", 1]]),
        noCharge: !!jt.noCharge,
        leadTechnicianId: tech.id,
        createdOn: iso(addDays(start, -rngJob.int(0, 6))),
        modifiedOn: iso(addHours(start, jt.hours + 2)),
        completedOn,
        summary: buildJobSummary(rngJob, jt, cust),
        customerName: cust.name,
        _jobType: jt,
        _tech: tech,
        _start: start,
      };
      world.jobs.push(job);

      // ---- Appointments -----------------------------------------------------
      // Most jobs are one visit. Installs and some repairs need a return trip;
      // that population is exactly what the Return Visit report exists to find.
      const returnVisitChance = jt.category === "Install" ? 0.22 : jt.category === "Warranty" ? 0.45 : 0.09;
      const apptCount = rngJob.chance(returnVisitChance) ? rngJob.weighted([[2, 8], [3, 2], [4, 1]]) : 1;

      for (let a = 0; a < apptCount; a++) {
        const aStart = a === 0 ? start : addDays(start, rngJob.int(1, 12));
        const aEnd = addHours(aStart, Math.max(1, jt.hours / apptCount));
        const aTech = a === 0 ? tech : rngJob.chance(0.65) ? tech : techForJobType(jt);
        world.appointments.push({
          id: apptId++,
          jobId: job.id,
          appointmentNumber: `${job.jobNumber}-${a + 1}`,
          start: iso(aStart),
          end: iso(aEnd),
          arrivalWindowStart: iso(addHours(aStart, -1)),
          arrivalWindowEnd: iso(addHours(aStart, 1)),
          status: aStart > NOW ? "Scheduled" : status === "Canceled" ? "Canceled" : "Done",
          specialInstructions: rngJob.chance(0.18) ? rngJob.pick(SPECIAL_INSTRUCTIONS) : null,
          technicianIds: [aTech.id],
          technicianId: aTech.id,
          technician: { id: aTech.id, name: aTech.name },
          assignments: [{ technicianId: aTech.id, technician: { id: aTech.id, name: aTech.name } }],
          _techRate: aTech._laborRate,
          _hours: Math.max(1, jt.hours / apptCount),
        });
      }
      job._apptCount = apptCount;

      // ---- Invoice ----------------------------------------------------------
      // PLANTED DEFECT: ~4% of completed, chargeable jobs get no invoice. That
      // is the Open Jobs report's whole job — finding revenue that walked out
      // the door. Membership and no-charge types are correctly excluded.
      const shouldInvoice =
        status === "Completed" &&
        !jt.membership &&
        !jt.noCharge &&
        !rngJob.chance(0.04);

      if (shouldInvoice) {
        const inv = buildInvoice(rngJob, { job, jt, cust, loc, world, invId: invId++, tech });
        world.invoices.push(inv);
        job._invoiceId = inv.id;

        // Payments: most invoices get paid, some sit on the balance.
        if (rngJob.chance(0.86)) {
          const paidOn = addDays(completedOn || start, rngJob.int(0, 28));
          if (paidOn <= NOW) {
            world.payments.push({
              id: payId++,
              referenceNumber: `PMT-${String(payId).slice(-6)}`,
              memo: rngJob.pick(["Card on file", "Check", "ACH", "Financing - GreenSky", "Cash"]),
              paidOn: iso(paidOn),
              total: inv.total,
              unappliedAmount: 0,
              type: rngJob.pick(["Credit Card", "Check", "ACH", "Financing", "Cash"]),
              status: "Posted",
              customer: { id: cust.id, name: cust.name },
              appliedTo: [
                { appliedId: payId + 900000, appliedTypeId: 1, appliedAmount: inv.total, appliedOn: iso(paidOn), invoiceId: inv.id },
              ],
            });
          }
        }
      } else if (status === "Completed" && !jt.membership && !jt.noCharge) {
        job._missedInvoice = true;
      }

      // ---- Purchase orders (install jobs pull material) ----------------------
      if (jt.category === "Install" && status === "Completed" && rngJob.chance(0.72)) {
        const vendor = rngJob.pick(world.vendors);
        const items = rngJob.sample(world.pricebook.materials.filter((m) => !m._duplicateOf), rngJob.int(2, 6)).map((m) => ({
          skuName: m.displayName,
          skuId: m.id,
          quantity: rngJob.int(1, 8),
          cost: m.cost,
          total: 0,
        }));
        items.forEach((it) => (it.total = Math.round(it.cost * it.quantity * 100) / 100));
        const subTotal = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
        world.purchaseOrders.push({
          id: poId++,
          number: `PO-${String(poId).slice(-6)}`,
          jobId: job.id,
          total: Math.round(subTotal * 1.0725 * 100) / 100,
          subTotal,
          tax: Math.round(subTotal * 0.0725 * 100) / 100,
          status: { name: "Received", value: 3 },
          vendor: { id: vendor.id, name: vendor.name },
          vendorId: vendor.id,
          sentOn: iso(addDays(start, -rngJob.int(1, 5))),
          items,
        });
      }

      // ---- Payroll rows -----------------------------------------------------
      if (status === "Completed" || status === "InProgress") {
        const jobAppts = world.appointments.filter((a) => a.jobId === job.id);
        jobAppts.forEach((ap) => {
          const hours = Math.round(ap._hours * (1 + rngJob.money(-0.12, 0.28)) * 100) / 100;
          world.laborSplits.push({
            id: `LS-${ap.id}`,
            jobId: job.id,
            JobId: job.id,
            jobNumber: job.jobNumber,
            appointmentId: ap.id,
            technicianId: ap.technicianId,
            split: 1,
            hours,
            hoursWorked: hours,
            paidDurationHours: hours,
            startedOn: ap.start,
            endedOn: ap.end,
          });
          world.jobTimesheets.push({
            id: `TS-${ap.id}`,
            jobId: job.id,
            JobId: job.id,
            jobNumber: job.jobNumber,
            appointmentId: ap.id,
            technicianId: ap.technicianId,
            dispatchedOn: iso(addHours(ap.start, -0.4)),
            arrivedOn: ap.start,
            doneOn: ap.end,
            canceledOn: null,
            paidDurationHours: hours,
          });
          const techRec = world.technicians.find((t) => t.id === ap.technicianId);
          world.grossPayItems.push({
            id: `GP-${ap.id}`,
            jobId: job.id,
            JobId: job.id,
            jobNumber: job.jobNumber,
            employeeId: ap.technicianId,
            payrollId: `PR-${ap.id}`,
            activity: jt.category === "Install" ? "Install Labor" : "Service Labor",
            payoutType: "Hourly",
            paidTimeType: "Regular",
            hoursWorked: hours,
            regularHours: hours,
            paidDurationHours: hours,
            amount: Math.round(hours * (techRec ? techRec._laborRate : 32) * 100) / 100,
            startedOn: ap.start,
            endedOn: ap.end,
            date: dateOnly(ap.start),
          });
        });
      }

      // ---- Installed equipment (install jobs create units) --------------------
      if (jt.category === "Install" && status === "Completed") {
        const isWh = /water heater|tankless/i.test(jt.name);
        const pool = isWh ? C.EQUIPMENT_MANUFACTURERS.waterHeater : C.EQUIPMENT_MANUFACTURERS.hvac;
        const mfg = rngJob.pick(pool);
        const unitCount = /hvac install/i.test(jt.name) ? 2 : 1;
        // PLANTED DEFECT: ~30% of installs never got entered into ST. The
        // Install Tracker exists to catch exactly this gap.
        const enteredInSt = rngJob.chance(0.7);
        for (let u = 0; u < unitCount; u++) {
          if (!enteredInSt) break;
          const installedOn = completedOn || iso(start);
          world.installedEquipment.push({
            id: eqId++,
            locationId: loc.id,
            customerId: cust.id,
            jobId: job.id,
            name: jt.name.replace(" Install", ""),
            manufacturer: mfg.name,
            model: rngJob.pick(mfg.models),
            serialNumber: makeSerial(rngJob, mfg.name, new Date(installedOn)),
            installedOn,
            manufacturerWarrantyStart: installedOn,
            manufacturerWarrantyEnd: iso(addDays(installedOn, 365 * (isWh ? 6 : 10))),
            active: true,
            _jobId: job.id,
          });
        }
        job._equipmentInSt = enteredInSt;
        // PLANTED DEFECT: warranty registration lags further behind than ST entry.
        job._warrantyRegistered = enteredInSt && rngJob.chance(0.62);
      }

      // ---- Memberships --------------------------------------------------------
      if (jt.category === "Install" && status === "Completed" && rngJob.chance(0.55)) {
        const from = completedOn || iso(start);
        const mem = {
          id: memId++,
          customerId: cust.id,
          locationIds: [loc.id],
          membershipTypeId: 7001,
          membershipTypeName: "Ground Club - Annual",
          status: "Active",
          from,
          to: iso(addDays(from, 365)),
          businessUnitId: 2005,
          _fromJobId: job.id,
        };
        world.memberships.push(mem);
        const visits = 2;
        for (let v = 0; v < visits; v++) {
          world.recurringServices.push({
            id: recSvcId++,
            membershipId: mem.id,
            name: v === 0 ? "Cooling Maintenance" : "Heating Maintenance",
            from: iso(addDays(from, v * 182)),
            recurrenceInterval: 6,
            durationLength: 12,
            firstVisitComplete: v === 0 ? rngJob.chance(0.6) : false,
            memo: null,
          });
        }
      }
    }
  }

  // Sort chronologically — several consumers assume rough ordering.
  world.jobs.sort((a, b) => new Date(a.createdOn) - new Date(b.createdOn));
  world.appointments.sort((a, b) => new Date(a.start) - new Date(b.start));
  world.invoices.sort((a, b) => new Date(a.invoicedOn) - new Date(b.invoicedOn));

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------
  world.calls = buildCalls(world, NOW);

  // -------------------------------------------------------------------------
  // Indexes — every mock lookup goes through these, so pages stay fast.
  // -------------------------------------------------------------------------
  world.index = buildIndexes(world);

  world.stats = {
    customers: world.customers.length,
    locations: world.locations.length,
    jobs: world.jobs.length,
    appointments: world.appointments.length,
    invoices: world.invoices.length,
    payments: world.payments.length,
    purchaseOrders: world.purchaseOrders.length,
    installedEquipment: world.installedEquipment.length,
    memberships: world.memberships.length,
    calls: world.calls.length,
    pricebookItems: world.pricebookAll.length,
    buildMs: Date.now() - t0,
  };

  return world;
}

// ---------------------------------------------------------------------------
// Sub-builders
// ---------------------------------------------------------------------------

const SPECIAL_INSTRUCTIONS = [
  "Gate code 4417. Dog in back yard - friendly.",
  "Customer works nights, please call before arriving.",
  "Park in driveway only, HOA tickets street parking.",
  "Basement access through side door.",
  "Elderly customer - please knock loudly.",
  "Tenant will meet tech, owner is billing party.",
  "Unit is on the roof, ladder required.",
  "Call 30 minutes out.",
  "Lockbox on front hose bib, code 2290.",
];

function buildJobSummary(rng, jt, cust) {
  const lines = {
    Service: [
      "Customer reports unit running but not keeping up.",
      "Intermittent operation, worse in the afternoon.",
      "Customer hears grinding noise on startup.",
      "System short cycling since last week.",
      "No response from thermostat.",
      "Water around the base of the unit.",
      "Customer smells something burning when heat kicks on.",
    ],
    Install: [
      "Replacing aging system, customer approved estimate.",
      "Full changeout, existing equipment past service life.",
      "New install per estimate. Permit pulled.",
      "Upgrade to higher efficiency equipment, financing approved.",
    ],
    Membership: [
      "Scheduled maintenance visit per membership agreement.",
      "Seasonal tune-up, member visit 1 of 2.",
      "Annual inspection under Ground Club plan.",
    ],
    Warranty: [
      "Return visit - part arrived, installing under warranty.",
      "Callback on prior repair, no charge.",
      "Warranty claim follow-up.",
    ],
    Sales: [
      "Customer requested estimate for replacement.",
      "Second opinion on quoted repair.",
      "In-home consultation for system upgrade.",
    ],
  };
  const pool = lines[jt.category] || lines.Service;
  return rng.pick(pool);
}

function makeSerial(rng, manufacturer, installedDate) {
  const yr = installedDate.getFullYear() - rng.int(0, 1);
  const wk = String(rng.int(1, 52)).padStart(2, "0");
  const letters = "ABCDEFGHJKLMNPRSTUVWXYZ";
  const rand = (n) => Array.from({ length: n }, () => letters[rng.int(0, letters.length - 1)]).join("");
  const digits = (n) => Array.from({ length: n }, () => rng.int(0, 9)).join("");

  // Each manufacturer encodes the build date differently. The decoders in
  // src/services/*Serial*.js parse these, so the formats have to be real.
  switch (manufacturer) {
    case "Rinnai":
      // Rinnai: 2-digit year + 2-digit month + serial
      return `${String(yr).slice(-2)}${String(rng.int(1, 12)).padStart(2, "0")}${digits(6)}`;
    case "Bradford White":
      // Bradford White: letter-coded year + letter-coded month + 6 digits
      return `${letters[(yr - 2000) % letters.length]}${letters[rng.int(0, 11)]}${digits(6)}`;
    case "American Standard":
    case "Trane":
      // Trane/AS: single-digit year + 2-digit week + plant letter + serial
      return `${String(yr).slice(-1)}${wk}${rand(1)}${digits(5)}`;
    default:
      return `${String(yr).slice(-2)}${wk}${rand(2)}${digits(5)}`;
  }
}

function buildInvoice(rng, { job, jt, cust, loc, world, invId, tech }) {
  const items = [];
  const target = jt.avgTicket > 0 ? rng.gaussianClamped(jt.avgTicket, jt.avgTicket * 0.32, jt.avgTicket * 0.35, jt.avgTicket * 2.4) : 0;

  if (jt.category === "Install") {
    // Installs: one big equipment line + a few materials + permit/haul fees.
    const isWh = /water heater|tankless/i.test(jt.name);
    const pool = world.pricebook.equipment.filter((e) =>
      isWh ? /water heater|tankless/i.test(e.displayName) : !/water heater|tankless/i.test(e.displayName)
    );
    const eq = rng.pick(pool.length ? pool : world.pricebook.equipment);
    items.push(lineFrom(eq, 1));
    rng.sample(world.pricebook.materials.filter((m) => !m._duplicateOf), rng.int(2, 5)).forEach((m) =>
      items.push(lineFrom(m, rng.int(1, 6)))
    );
    const permit = world.pricebook.discountsAndFees.find((f) => /permit/i.test(f.displayName));
    if (permit && rng.chance(0.8)) items.push(lineFrom(permit, 1));
    const haul = world.pricebook.discountsAndFees.find((f) => /haul/i.test(f.displayName));
    if (haul && rng.chance(0.7)) items.push(lineFrom(haul, 1));
  } else {
    // Service: a diagnostic + one or two repair services + parts.
    const diag = world.pricebook.services.find((s) => /diagnostic/i.test(s.displayName));
    if (diag && rng.chance(0.85)) items.push(lineFrom(diag, 1));
    rng.sample(world.pricebook.services.filter((s) => !/diagnostic/i.test(s.displayName)), rng.int(1, 2)).forEach((s) =>
      items.push(lineFrom(s, 1))
    );
    if (rng.chance(0.6)) {
      rng.sample(world.pricebook.materials.filter((m) => !m._duplicateOf), rng.int(1, 3)).forEach((m) =>
        items.push(lineFrom(m, rng.int(1, 3)))
      );
    }
  }

  // Nudge toward the job type's average ticket without breaking line math.
  let subtotal = items.reduce((s, i) => s + i.total, 0);
  if (target > 0 && subtotal > 0) {
    const scale = target / subtotal;
    if (scale < 0.6 || scale > 1.7) {
      items.forEach((i) => {
        i.price = Math.round(i.price * scale * 100) / 100;
        i.unitPrice = i.price;
        i.total = Math.round(i.price * i.quantity * 100) / 100;
      });
      subtotal = items.reduce((s, i) => s + i.total, 0);
    }
  }

  // Occasional discount line.
  if (rng.chance(0.12)) {
    const disc = world.pricebook.discountsAndFees.find((f) => f.price < 0);
    if (disc) items.push(lineFrom(disc, 1));
  }

  subtotal = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
  const tax = Math.round(subtotal * 0.0725 * 100) / 100;
  const total = Math.round((subtotal + tax) * 100) / 100;
  const invoicedOn = job.completedOn || job.modifiedOn;

  return {
    id: invId,
    number: `INV-${invId}`,
    invoiceNumber: `INV-${invId}`,
    referenceNumber: job.jobNumber,
    total,
    subtotal,
    subTotal: subtotal, // both casings — different services read different ones
    tax,
    salesTax: tax,
    balance: 0,
    invoicedOn: invoicedOn,
    invoiceDate: invoicedOn,
    date: invoicedOn,
    createdOn: invoicedOn,
    summary: `<p>${job.summary}</p><p>Work performed by ${tech.name}.</p>`,
    status: { name: "Posted", value: 2 },
    statusName: "Posted",
    customer: { id: cust.id, name: cust.name },
    customerId: cust.id,
    location: { id: loc.id, name: loc.name },
    businessUnit: { id: jt.bu, name: (world.businessUnits.find((b) => b.id === jt.bu) || {}).name },
    job: { id: job.id, number: job.jobNumber },
    jobId: job.id,
    jobNumber: job.jobNumber,
    items,
  };
}

function lineFrom(pb, qty) {
  const price = pb.price;
  return {
    id: `${pb.id}-${qty}`,
    skuName: pb.displayName,
    sku: { id: pb.id, code: pb.code, displayName: pb.displayName },
    skuId: pb.id,
    code: pb.code,
    description: pb.description,
    name: pb.displayName,
    quantity: qty,
    qty,
    price,
    unitPrice: price,
    total: Math.round(price * qty * 100) / 100,
    cost: pb.cost || 0,
    totalCost: Math.round((pb.cost || 0) * qty * 100) / 100,
    type: pb.skuType,
    skuType: pb.skuType,
  };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

function buildCalls(world, NOW) {
  const rng = new Rng(ROOT_SEED).fork("calls");
  const calls = [];
  let callId = 700000;

  const csrs = world.office.filter((o) => o._csr);
  const CALL_DAYS = 90;

  for (let d = addDays(NOW, -CALL_DAYS); d <= NOW; d = addDays(d, 1)) {
    const dow = d.getDay();
    if (dow === 0) continue;
    const count = dow === 6 ? rng.int(0, 4) : Math.round(rng.gaussianClamped(9, 3, 2, 18));

    for (let k = 0; k < count; k++) {
      const start = new Date(d);
      start.setHours(rng.int(7, 18), rng.int(0, 59), rng.int(0, 59), 0);
      if (start > NOW) continue;

      const knownCaller = rng.chance(0.05) ? rng.pick(C.DEMO_KNOWN_CALLERS) : null;
      const internal = !knownCaller && rng.chance(0.06);
      const existingCustomer = !knownCaller && !internal && rng.chance(0.62);
      const cust = existingCustomer ? rng.pick(world.customers) : null;

      let phone;
      if (knownCaller) phone = knownCaller.phone;
      else if (internal) phone = rng.pick([...world.technicians, ...world.office]).phoneNumber;
      else if (cust) phone = cust._primaryPhone;
      else phone = makePhone(rng);

      const reason = knownCaller
        ? world.callReasons.find((r) => r.name === knownCaller.reason)
        : internal
        ? world.callReasons.find((r) => r.name === "Employee - Internal")
        : rng.weighted(world.callReasons.filter((r) => r.name !== "Employee - Internal").map((r) => [r, r.type === "Booked" ? 5 : r.type === "Excused" ? 3 : 1]));

      const duration = reason.type === "Abandoned" ? rng.int(3, 25) : rng.int(45, 620);
      const agent = knownCaller
        ? world.office.find((o) => o.id === knownCaller.agentId) || rng.pick(csrs)
        : rng.pick(csrs);

      calls.push({
        id: callId++,
        stId: String(callId),
        receivedOn: iso(start),
        createdOn: iso(start),
        duration,
        from: phone,
        to: C.COMPANY.phone,
        direction: "Inbound",
        callType: reason.type,
        reason: { id: reason.id, name: reason.name },
        agent: { id: agent.id, name: agent.name },
        customerId: cust ? cust.id : null,
        customerName: cust ? cust.name : null,
        recordingUrl: `demo://recording/${callId}`,
        _knownCaller: knownCaller || null,
        _internal: internal,
        _reasonName: reason.name,
      });
    }
  }

  calls.sort((a, b) => new Date(a.receivedOn) - new Date(b.receivedOn));
  return calls;
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const item of arr) {
    const k = String(keyFn(item));
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}

function byId(arr) {
  const m = new Map();
  for (const item of arr) m.set(String(item.id), item);
  return m;
}

function buildIndexes(world) {
  return {
    customerById: byId(world.customers),
    locationById: byId(world.locations),
    jobById: byId(world.jobs),
    jobByNumber: new Map(world.jobs.map((j) => [String(j.jobNumber), j])),
    invoiceById: byId(world.invoices),
    paymentById: byId(world.payments),
    technicianById: byId(world.technicians),
    employeeById: byId(world.employees),
    jobTypeById: byId(world.jobTypes),
    jobTypeByName: new Map(world.jobTypes.map((t) => [t.name.toLowerCase(), t])),
    businessUnitById: byId(world.businessUnits),
    campaignById: byId(world.campaigns),
    vendorById: byId(world.vendors),
    pricebookById: byId(world.pricebookAll),
    callById: byId(world.calls),
    membershipById: byId(world.memberships),

    locationsByCustomer: groupBy(world.locations, (l) => l.customerId),
    contactsByCustomer: groupBy(world.contacts, (c) => c.customerId),
    jobsByCustomer: groupBy(world.jobs, (j) => j.customerId),
    jobsByLocation: groupBy(world.jobs, (j) => j.locationId),
    appointmentsByJob: groupBy(world.appointments, (a) => a.jobId),
    invoicesByJob: groupBy(world.invoices, (i) => i.jobId),
    invoicesByCustomer: groupBy(world.invoices, (i) => i.customerId),
    posByJob: groupBy(world.purchaseOrders, (p) => p.jobId),
    equipmentByLocation: groupBy(world.installedEquipment, (e) => e.locationId),
    laborSplitsByJob: groupBy(world.laborSplits, (r) => r.jobId),
    timesheetsByJob: groupBy(world.jobTimesheets, (r) => r.jobId),
    grossPayByJob: groupBy(world.grossPayItems, (r) => r.jobId),
    recurringByMembership: groupBy(world.recurringServices, (r) => r.membershipId),
    membershipsByCustomer: groupBy(world.memberships, (m) => m.customerId),
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _world = null;

/** Build once per process; every mock reads from this instance. */
function getWorld() {
  if (!_world) {
    _world = buildWorld();
    if (process.env.DEMO_QUIET !== "true") {
      const s = _world.stats;
      console.log(
        `[demo] world built in ${s.buildMs}ms — ${s.customers} customers, ` +
          `${s.jobs} jobs, ${s.invoices} invoices, ${s.calls} calls, ` +
          `${s.pricebookItems} pricebook items (seed ${_world.seed})`
      );
    }
  }
  return _world;
}

/** Rebuild from scratch — used by the demo reset endpoint. */
function resetWorld() {
  _world = null;
  return getWorld();
}

module.exports = {
  getWorld,
  resetWorld,
  buildWorld,
  // exported for the mock layer and the DB seeder
  helpers: { iso, dateOnly, addDays, addHours, makePhone, makeAddress, makePersonName, makeSerial, groupBy, byId },
};

/* ---------------------------------------------------------------------------
 * PLANTED DEFECTS — the imperfections this generator introduces on purpose,
 * because several pages in this app exist specifically to surface them.
 *
 *   ~4%  of completed chargeable jobs have no invoice        -> /open-jobs
 *   ~9%  of addresses have formatting drift or a bad ZIP     -> /address
 *   ~30% of completed installs were never entered in ST      -> /install-tracker
 *   ~38% of ST-entered installs lack warranty registration   -> /install-tracker
 *   ~22% of installs need a return visit (2-4 appointments)  -> return visit report
 *   6    duplicate pricebook SKUs with drifted pricing       -> /pricebook merge
 *   ~8%  of customers carry an open balance                  -> /customer-review
 *   ~14% of invoices go unpaid past 28 days                  -> aging
 *
 * Membership and no-charge job types are explicitly excluded from the
 * missed-invoice population — flagging a dues-covered maintenance visit as lost
 * revenue was a real false-positive class this report had to learn to ignore.
 * ------------------------------------------------------------------------- */
