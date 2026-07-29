/**
 * officeTeam.js
 *
 * Canonical list of our office / CSR team, written "First Last".
 *
 * Single source of truth for two consumers:
 *   1. monthlyReview.js  — the escalation-assignment dropdown (order here is
 *      preserved in the dropdown).
 *   2. classificationService.js — folds these names into the Call Reviews
 *      staff roster so the model never mistakes an office person for the
 *      customer, even when they have no entry in the employee_phones table.
 *
 * If someone joins the office team, add them here and both places pick it up.
 */

const OFFICE_TEAM_NAMES = [
  "Priya Raghunathan",
  "Danielle Cormier",
  "Renata Vasilenko",
  "Tomas Iriarte",
  "Bea Lindqvist",
  "Harold Kittridge",
  "Simone Achebe",
  "Gus Vandermolen",
];

module.exports = { OFFICE_TEAM_NAMES };
