// Site-wide settings, all set from the repository .env (see next.config.ts).
// Empty contact values hide the matching links instead of showing placeholders.
export const site = {
  url: process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3500',
  // Empty: the dashboard on the same host at port 3400 (works on a LAN in development).
  dashboardUrl: process.env.NEXT_PUBLIC_DASHBOARD_URL || '',
  phone: process.env.NEXT_PUBLIC_CONTACT_PHONE || '',
  email: process.env.NEXT_PUBLIC_CONTACT_EMAIL || '',
  whatsapp: process.env.NEXT_PUBLIC_CONTACT_WHATSAPP || '', // digits with country code, e.g. 919800000000
};

export const hasContact = Boolean(site.phone || site.email || site.whatsapp);
