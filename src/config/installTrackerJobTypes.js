/**
 * src/config/installTrackerJobTypes.js
 *
 * The ServiceTitan job types the Install Tracker watches. After one of these
 * jobs is completed, the office needs to confirm two follow-through steps
 * happened:
 *   1. the equipment was listed in ServiceTitan (Installed Equipment), and
 *   2. the manufacturer warranty was registered.
 *
 * This is the single source of truth for "what counts as an install." To add
 * or drop a type, edit INSTALL_JOB_TYPES below — nothing else changes. The
 * service resolves ids + names straight from here and defends the report with
 * a client-side jobTypeId filter, so a stray type can never slip in.
 *
 * IDs + names captured from the tenant's active job types on 2026-07-16.
 * Matching is by numeric `id`; `name` is display-only, so a rename in
 * ServiceTitan won't break the tracker. `category` groups the tile/summary.
 */

const INSTALL_JOB_TYPES = [
  { id: 1232, name: "HVAC Install",                  category: "HVAC" },
  { id: 1227, name: "Furnace Install",               category: "HVAC" },
  { id: 1229, name: "Boiler Install",                category: "HVAC" },
  { id: 1233, name: "Air Handler Install",           category: "HVAC" },
  { id: 1234, name: "Condenser Install",             category: "HVAC" },
  { id: 1216, name: "Water Heater Install",          category: "Water Heater" },
  { id: 1208, name: "Tankless Water Heater Install", category: "Water Heater" },
];

const _byId = new Map(INSTALL_JOB_TYPES.map((t) => [String(t.id), t]));

/** Numeric ids, for the ST jobs query (jobTypeIds=…). */
function installJobTypeIds() {
  return INSTALL_JOB_TYPES.map((t) => t.id);
}

/** String-id Set, for the defensive client-side filter after the ST call. */
function installJobTypeIdSet() {
  return new Set(INSTALL_JOB_TYPES.map((t) => String(t.id)));
}

function jobTypeName(id) {
  const t = _byId.get(String(id));
  return t ? t.name : null;
}

function jobTypeCategory(id) {
  const t = _byId.get(String(id));
  return t ? t.category : null;
}

module.exports = {
  INSTALL_JOB_TYPES,
  installJobTypeIds,
  installJobTypeIdSet,
  jobTypeName,
  jobTypeCategory,
};
