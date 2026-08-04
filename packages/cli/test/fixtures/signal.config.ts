/**
 * Example config-as-code file for `signal deploy` (B3-D9). The default export is a
 * `{ workflows: [...] }` payload; each item's `key` is its stable identity.
 */
export default {
  workflows: [
    {
      key: 'checkout-csat',
      event_name: 'checkout_completed',
      status: 'active',
      metric_type: 'CSAT',
      rating_type: 'star',
      rating_scale_max: 5,
      header_text: 'How was your checkout?',
      positive_threshold: 4,
      chips_on_negative: ['Slow', 'Confusing'],
      sampling_rate: 1,
      // B5 branched post-submit actions.
      onPositive: { type: 'store_review' },
      onNegative: { type: 'redirect', url: 'https://support.acme.com/checkout' },
    },
  ],
};
