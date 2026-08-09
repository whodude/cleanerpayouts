// Maps raw ConvertLabs API resources into clean shapes the rest of the app consumes.
// Some shapes here were verified against the live API and differ from the doc's placeholder
// examples (see convert-labs-api-doc.docx), notably address (object, not string) and teams
// (array of assigned cleaners with live GPS check in/out, not an opaque string).

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function formatAddress(addr) {
  if (!addr) return null;
  if (typeof addr === 'string') return addr;
  const parts = [];
  if (addr.street_address) parts.push(addr.street_address);
  if (addr.apt_number && addr.apt_number !== 'N/A') parts.push(addr.apt_number);
  const cityState = [addr.city, addr.state].filter(Boolean).join(', ');
  if (cityState) parts.push(cityState);
  if (addr.zipcode) parts.push(addr.zipcode);
  return parts.join(', ');
}

function normalizeTeamMember(member) {
  if (!member) return null;
  const tt = member.time_tracking || {};
  return {
    id: member.id,
    fullName: member.full_name,
    title: member.title, // short form, e.g. "Gina T.", matches the roster sheet's CleanerName
    color: member.color,
    ableToTakeJob: Boolean(member.able_to_take_job),
    timeTracking: {
      status: tt.status || null, // observed: "checked_out". "checked_in" expected, unverified.
      checkIn: tt.check_in || null,
      checkOut: tt.check_out || null,
      trackedDurationMinutes: toNumber(tt.tracked_duration)
    }
  };
}

// Best-effort live status for a booking, derived from its first assigned team member.
// Values: 'unassigned' | 'not_started' | 'checked_in' | 'checked_out'
// Only 'checked_out' has been observed against the live API so far, the rest are reasoned
// from the field name. Revisit once a booking is seen mid-clean.
function deriveLiveStatus(teamMembers) {
  if (!teamMembers || teamMembers.length === 0) return 'unassigned';
  const status = teamMembers[0].timeTracking.status;
  if (status === 'checked_out') return 'checked_out';
  if (status === 'checked_in') return 'checked_in';
  return 'not_started';
}

function normalizeBooking(raw) {
  if (!raw) return null;
  const summary = raw.summary || {};
  const teams = (raw.teams || []).map(normalizeTeamMember).filter(Boolean);
  const serviceDateOnly = typeof raw.service_date === 'string' ? raw.service_date.slice(0, 10) : null;

  return {
    id: raw.id,
    status: raw.status,
    type: raw.type,
    serviceDate: raw.service_date,
    serviceDateOnly,
    durationMinutes: toNumber(raw.duration),
    address: formatAddress(raw.address),
    addressRaw: typeof raw.address === 'object' ? raw.address : null,
    staffNotes: raw.staff_notes && raw.staff_notes !== 'N/A' ? raw.staff_notes : null,
    customerNotes: raw.customer_notes && raw.customer_notes !== 'N/A' ? raw.customer_notes : null,
    isFirstInSeries: raw.is_first_booking_in_series === true || raw.is_first_booking_in_series === 'true',
    locationId: raw.location_id,
    paymentMethod: raw.payment_method,
    frequency: raw.frequency ? { id: raw.frequency.id, name: raw.frequency.name } : null,
    service: raw.service ? { id: raw.service.id, name: raw.service.name } : null,
    customer: raw.customer
      ? {
          id: raw.customer.id,
          firstName: raw.customer.first_name,
          lastName: raw.customer.last_name,
          email: raw.customer.email,
          phone: raw.customer.phone
        }
      : null,
    extras: (raw.extras || []).map((e) => ({ id: e.id, name: e.name, quantity: e.quantity, price: toNumber(e.price) })),
    teams,
    liveStatus: deriveLiveStatus(teams),
    pricing: {
      currency: summary.currency,
      total: toNumber(summary.total),
      calculatedTotal: toNumber(summary.calculated_total),
      subtotal: toNumber(summary.subtotal),
      subtotalOverride: toNumber(summary.subtotal_override),
      discounts: summary.discounts || {},
      fees: summary.fees || {},
      taxes: summary.taxes || {},
      tip: toNumber(summary.tip)
    },
    createdAt: raw.created_at,
    updatedAt: raw.updated_at
  };
}

function normalizeBookings(rawList) {
  return (rawList || []).map(normalizeBooking).filter(Boolean);
}

function normalizeSettings(raw) {
  if (!raw) return null;
  return {
    hoursToRequest: toNumber(raw.hours_to_request),
    minsToRequest: toNumber(raw.mins_to_request),
    timeArrival: raw.time_arrival,
    arrivalWindowMinutes: toNumber(raw.arrival_window),
    cancelHours: toNumber(raw.cancel_hours),
    cancelAmount: toNumber(raw.cancel_amount),
    cancelPercent: toNumber(raw.cancel_percent),
    cancelLabel: raw.cancel_label,
    feeDayLabel: raw.fee_day_label,
    feeDayAmount: toNumber(raw.fee_day_amount),
    feeDayPercent: toNumber(raw.fee_day_percent),
    referralProgramEnabled: raw.referral_program_enabled === true || raw.referral_program_enabled === 'true',
    referralAmount: toNumber(raw.referral_amount),
    workSchedules: raw.work_schedules,
    timeSlots: raw.time_slots
  };
}

module.exports = { normalizeBooking, normalizeBookings, normalizeSettings };
