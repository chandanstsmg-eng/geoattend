// All page copy, English and Hindi. Keep the two in step: `hi` is typed against `en`.
// Only claim what the product actually does (see packages/shared and apps/api).

export type Lang = 'en' | 'hi';

const en = {
  meta: {
    title: 'GeoAttend by Dhisha AI — attendance with proof of presence',
    description:
      'Staff mark attendance on their own phone, only when GPS confirms they are at the workplace. Live team map, absence alerts and clean reports for Indian businesses. No hardware needed.',
  },
  nav: { how: 'How it works', proof: 'Why it is accurate', features: 'Features', faq: 'FAQ', login: 'Owner login', demo: 'Start free', menu: 'Menu', lang: 'हिंदी' },
  hero: {
    badge: 'Made in India by Dhisha AI',
    title1: 'Attendance that',
    titleMark: 'proves',
    title2: 'your staff were really there.',
    lead: 'Your team marks attendance on their own phone, and only when GPS confirms they are inside the workplace. No register, no buddy punching, no biometric machine to buy.',
    primary: 'Create your free account',
    secondary: 'See how it works',
    points: ['Works on any Android or iPhone', 'Set up a workplace in minutes', 'Tracking only during the shift'],
  },
  phone: {
    shift: 'Shift running',
    away: 'You are 42 m away',
    unlock: 'Attendance unlocks within 30 m',
    inside: 'Inside workplace',
    marked: 'Attendance marked',
    at: '9:02 AM · photo verified',
  },
  live: { title: 'Today at Main Store', present: 'Present', away: 'Away too long', notIn: 'Not in yet' },
  who: {
    title: 'Built for teams that work on location',
    items: ['Shops & showrooms', 'Factories', 'Construction sites', 'Security agencies', 'Hospitals & clinics', 'Schools & coaching', 'Restaurants', 'Warehouses', 'Hotels', 'Facility services'],
  },
  compare: {
    title: 'From a register you hope is right, to a record you can trust',
    before: 'Without GeoAttend',
    after: 'With GeoAttend',
    rows: [
      ['A friend signs the register for a late colleague.', 'Attendance only unlocks on the staff member’s own phone, inside the workplace.'],
      ['You phone around to find out who has reached the site.', 'A live map shows who has started their shift and where.'],
      ['Someone leaves mid-shift and nobody notices.', 'You get an alert when someone stays out of the workplace too long.'],
      ['Month-end: hours of totalling registers into Excel.', 'Download clean attendance reports as CSV in one click.'],
      ['Arguments over “I was there” with no proof.', 'Every record has time, location accuracy and a photo, and every correction is logged.'],
    ],
  },
  how: {
    title: 'Running in three steps',
    steps: [
      { t: 'Draw your workplace', d: 'Search your address and set the attendance radius on the map. Add as many sites as you have.' },
      { t: 'Add staff and shifts', d: 'Add employees and their shift timings. They sign in to the GeoAttend app on their phone.' },
      { t: 'Watch it work', d: 'Staff start their shift, walk in, and mark attendance. You see Present, Late or Away on your dashboard as it happens.' },
    ],
  },
  proof: {
    kicker: 'Why it is accurate',
    title: 'Phone GPS is never perfect. GeoAttend plans for that.',
    lead: 'Most apps check one dot on a map. Every phone location comes with an error circle, so GeoAttend checks the whole circle and lets the server, not the phone, decide.',
    legend: { zone: 'Workplace radius', inside: 'Clearly inside: accepted', unsure: 'Not sure: waits for a better fix', outside: 'Clearly outside: refused' },
    points: [
      { t: 'Weak GPS is not trusted', d: 'Readings with poor accuracy are set aside instead of being counted for or against anyone.' },
      { t: 'Edge cases wait, not guess', d: 'If the error circle crosses the boundary, the app waits for a better reading rather than guessing.' },
      { t: 'Fake GPS gets flagged', d: 'Mock-location signals from the phone are recorded and shown to you for review.' },
      { t: 'Photo after arrival', d: 'The attendance photo can be taken only after the location is verified, so the two always match.' },
      { t: 'Server decides', d: 'The phone sends evidence; the server applies your rules. Changing the phone’s clock or app does not change the result.' },
      { t: 'No flicker at the gate', d: 'A small exit buffer stops people standing at the boundary from bouncing between in and out.' },
    ],
  },
  features: {
    title: 'Everything an owner needs, nothing they don’t',
    items: [
      { t: 'Live team map', d: 'See who is on shift and where, updated live.' },
      { t: 'Absence alerts', d: 'Get notified when someone leaves the workplace for too long or tracking stops.' },
      { t: 'Photo attendance', d: 'A selfie at check-in, stored privately and visible only to administrators.' },
      { t: 'Shifts & late rules', d: 'Set shift timings per employee and see who came in late.' },
      { t: 'Works offline', d: 'Readings are saved on the phone and sent when the network comes back.' },
      { t: 'Corrections with history', d: 'Fix a record with a reason. The original and the change are both kept.' },
      { t: 'Reports in one click', d: 'Download attendance and absence reports as CSV for salary or accounts.' },
      { t: 'Multiple sites', d: 'Manage many workplaces, each with its own radius and rules.' },
    ],
  },
  privacy: {
    title: 'Fair to your staff, too',
    lead: 'Good attendance tracking should not mean watching people all day.',
    points: [
      'Location is tracked only during a shift the employee starts themselves.',
      'The app shows a clear notice whenever tracking is on.',
      'Staff see a plain-language privacy notice and their own history.',
      'Every time an administrator views location or photos, it is written to an audit log.',
    ],
  },
  faq: {
    title: 'Questions owners ask',
    items: [
      { q: 'Do I need to buy a biometric machine?', a: 'No. GeoAttend runs on the phones your staff already have. You manage everything from a web dashboard on your laptop or phone.' },
      { q: 'What if a staff member doesn’t have a smartphone?', a: 'An administrator can add or correct their attendance from the dashboard. The correction and its reason are saved in the audit log.' },
      { q: 'Can staff mark attendance from home?', a: 'No. Attendance unlocks only when the phone’s location is confirmed inside the workplace radius you set.' },
      { q: 'What if the internet is down at the site?', a: 'The app keeps readings on the phone and sends them when the connection returns, with the original times.' },
      { q: 'Will this drain my staff’s battery or track them at home?', a: 'Tracking runs only during a shift the employee starts and stops when the shift ends. Outside shifts, nothing is collected.' },
      { q: 'How long does setup take?', a: 'Adding a workplace and a few employees usually takes a few minutes. Create a free account and the dashboard walks you through five steps.' },
    ],
  },
  cta: { title: 'Set up your team in under 15 minutes', lead: 'Create your company account, add your workplace on the map, import your staff, and they mark attendance from their own phones today.', primary: 'Create your free account', talk: 'Talk to us' },
  footer: {
    tagline: 'Attendance with proof of presence.',
    by: 'A product by',
    product: 'Product',
    contact: 'Contact',
    whatsapp: 'WhatsApp',
    rights: 'All rights reserved.',
  },
};

export type Copy = typeof en;

const hi: Copy = {
  meta: {
    title: 'GeoAttend, Dhisha AI द्वारा — हाज़िरी जो सबूत के साथ लगे',
    description:
      'स्टाफ़ अपने ही फ़ोन से हाज़िरी लगाता है, और तभी जब GPS पक्का करे कि वे कार्यस्थल पर हैं। लाइव टीम मैप, गैरहाज़िरी अलर्ट और साफ़ रिपोर्ट। कोई मशीन नहीं चाहिए।',
  },
  nav: { how: 'कैसे काम करता है', proof: 'यह सटीक क्यों है', features: 'सुविधाएँ', faq: 'सवाल', login: 'मालिक लॉगिन', demo: 'मुफ़्त शुरू करें', menu: 'मेन्यू', lang: 'English' },
  hero: {
    badge: 'Dhisha AI द्वारा, भारत में बना',
    title1: 'ऐसी हाज़िरी जो',
    titleMark: 'साबित',
    title2: 'करे कि स्टाफ़ सच में वहाँ था।',
    lead: 'आपकी टीम अपने फ़ोन से हाज़िरी लगाती है, और सिर्फ़ तब जब GPS पक्का करे कि वे कार्यस्थल के अंदर हैं। न रजिस्टर, न किसी और की हाज़िरी, न बायोमेट्रिक मशीन का खर्च।',
    primary: 'मुफ़्त अकाउंट बनाएँ',
    secondary: 'देखें कैसे काम करता है',
    points: ['हर Android और iPhone पर चलता है', 'कुछ ही मिनट में कार्यस्थल सेट करें', 'ट्रैकिंग सिर्फ़ शिफ़्ट के दौरान'],
  },
  phone: {
    shift: 'शिफ़्ट चालू है',
    away: 'आप 42 मीटर दूर हैं',
    unlock: '30 मीटर के अंदर हाज़िरी खुलेगी',
    inside: 'कार्यस्थल के अंदर',
    marked: 'हाज़िरी लग गई',
    at: 'सुबह 9:02 · फ़ोटो सत्यापित',
  },
  live: { title: 'आज, मेन स्टोर', present: 'मौजूद', away: 'बहुत देर से बाहर', notIn: 'अभी नहीं आए' },
  who: {
    title: 'उन टीमों के लिए जो जगह पर काम करती हैं',
    items: ['दुकानें और शोरूम', 'फ़ैक्ट्रियाँ', 'कंस्ट्रक्शन साइट', 'सिक्योरिटी एजेंसी', 'अस्पताल और क्लिनिक', 'स्कूल और कोचिंग', 'रेस्टोरेंट', 'गोदाम', 'होटल', 'फ़ैसिलिटी सर्विस'],
  },
  compare: {
    title: 'भरोसे वाले रजिस्टर से, सबूत वाले रिकॉर्ड तक',
    before: 'GeoAttend के बिना',
    after: 'GeoAttend के साथ',
    rows: [
      ['दोस्त देर से आने वाले साथी की हाज़िरी लगा देता है।', 'हाज़िरी सिर्फ़ उसी कर्मचारी के फ़ोन पर, कार्यस्थल के अंदर खुलती है।'],
      ['कौन साइट पर पहुँचा, यह जानने के लिए फ़ोन करने पड़ते हैं।', 'लाइव मैप पर दिखता है किसने शिफ़्ट शुरू की और कहाँ है।'],
      ['कोई बीच शिफ़्ट में चला जाता है और पता नहीं चलता।', 'कोई ज़्यादा देर बाहर रहे तो आपको अलर्ट मिलता है।'],
      ['महीने के अंत में घंटों रजिस्टर से Excel में जोड़ना।', 'एक क्लिक में साफ़ हाज़िरी रिपोर्ट CSV में डाउनलोड करें।'],
      ['“मैं तो वहीं था” पर बहस, कोई सबूत नहीं।', 'हर रिकॉर्ड में समय, लोकेशन की सटीकता और फ़ोटो, और हर सुधार दर्ज होता है।'],
    ],
  },
  how: {
    title: 'तीन कदम में शुरू',
    steps: [
      { t: 'कार्यस्थल बनाएँ', d: 'मैप पर अपना पता खोजें और हाज़िरी का दायरा सेट करें। जितनी चाहें उतनी साइट जोड़ें।' },
      { t: 'स्टाफ़ और शिफ़्ट जोड़ें', d: 'कर्मचारी और उनकी शिफ़्ट का समय जोड़ें। वे अपने फ़ोन पर GeoAttend ऐप में लॉगिन करते हैं।' },
      { t: 'बस देखते रहें', d: 'स्टाफ़ शिफ़्ट शुरू करता है, अंदर आता है और हाज़िरी लगाता है। आपके डैशबोर्ड पर तुरंत मौजूद, लेट या बाहर दिखता है।' },
    ],
  },
  proof: {
    kicker: 'यह सटीक क्यों है',
    title: 'फ़ोन का GPS कभी पूरा सही नहीं होता। GeoAttend इसका ध्यान रखता है।',
    lead: 'ज़्यादातर ऐप मैप पर सिर्फ़ एक बिंदु देखते हैं। हर लोकेशन के साथ एक गलती का घेरा होता है, इसलिए GeoAttend पूरा घेरा जाँचता है, और फ़ैसला फ़ोन नहीं, सर्वर करता है।',
    legend: { zone: 'कार्यस्थल का दायरा', inside: 'साफ़ अंदर: मान्य', unsure: 'पक्का नहीं: बेहतर सिग्नल का इंतज़ार', outside: 'साफ़ बाहर: अमान्य' },
    points: [
      { t: 'कमज़ोर GPS पर भरोसा नहीं', d: 'कम सटीकता वाली रीडिंग को किसी के पक्ष या विपक्ष में नहीं गिना जाता।' },
      { t: 'शक हो तो इंतज़ार', d: 'अगर गलती का घेरा सीमा को पार करे, तो ऐप अंदाज़ा लगाने के बजाय बेहतर रीडिंग का इंतज़ार करता है।' },
      { t: 'नकली GPS पकड़ा जाता है', d: 'फ़ोन से मिलने वाले मॉक-लोकेशन संकेत दर्ज होते हैं और आपको जाँच के लिए दिखते हैं।' },
      { t: 'पहुँचने के बाद ही फ़ोटो', d: 'हाज़िरी की फ़ोटो लोकेशन पक्की होने के बाद ही ली जा सकती है, इसलिए दोनों हमेशा मेल खाते हैं।' },
      { t: 'फ़ैसला सर्वर का', d: 'फ़ोन सिर्फ़ जानकारी भेजता है; नियम सर्वर लगाता है। फ़ोन की घड़ी बदलने से नतीजा नहीं बदलता।' },
      { t: 'गेट पर उलझन नहीं', d: 'एक छोटा बफ़र सीमा पर खड़े व्यक्ति को बार-बार अंदर-बाहर गिने जाने से रोकता है।' },
    ],
  },
  features: {
    title: 'मालिक को जो चाहिए, बस वही',
    items: [
      { t: 'लाइव टीम मैप', d: 'कौन शिफ़्ट पर है और कहाँ है, लाइव देखें।' },
      { t: 'गैरहाज़िरी अलर्ट', d: 'कोई ज़्यादा देर कार्यस्थल से बाहर रहे या ट्रैकिंग रुके तो सूचना पाएँ।' },
      { t: 'फ़ोटो हाज़िरी', d: 'चेक-इन पर सेल्फ़ी, सुरक्षित रखी जाती है और सिर्फ़ एडमिन देख सकते हैं।' },
      { t: 'शिफ़्ट और लेट नियम', d: 'हर कर्मचारी की शिफ़्ट तय करें और देखें कौन देर से आया।' },
      { t: 'बिना इंटरनेट भी', d: 'रीडिंग फ़ोन में सेव रहती है और नेटवर्क आते ही भेजी जाती है।' },
      { t: 'इतिहास के साथ सुधार', d: 'कारण लिखकर रिकॉर्ड सुधारें। पुराना और नया दोनों सुरक्षित रहते हैं।' },
      { t: 'एक क्लिक में रिपोर्ट', d: 'सैलरी या हिसाब के लिए हाज़िरी और गैरहाज़िरी रिपोर्ट CSV में लें।' },
      { t: 'कई साइट', d: 'कई कार्यस्थल चलाएँ, हर एक का अपना दायरा और नियम।' },
    ],
  },
  privacy: {
    title: 'आपके स्टाफ़ के साथ भी न्याय',
    lead: 'अच्छी हाज़िरी का मतलब दिन भर निगरानी नहीं है।',
    points: [
      'लोकेशन सिर्फ़ उस शिफ़्ट के दौरान ट्रैक होती है जो कर्मचारी खुद शुरू करता है।',
      'ट्रैकिंग चालू होने पर ऐप साफ़ सूचना दिखाता है।',
      'स्टाफ़ को आसान भाषा में प्राइवेसी नोटिस और अपना इतिहास दिखता है।',
      'एडमिन जब भी लोकेशन या फ़ोटो देखता है, वह ऑडिट लॉग में दर्ज होता है।',
    ],
  },
  faq: {
    title: 'मालिकों के आम सवाल',
    items: [
      { q: 'क्या बायोमेट्रिक मशीन खरीदनी होगी?', a: 'नहीं। GeoAttend आपके स्टाफ़ के अपने फ़ोन पर चलता है। आप सब कुछ लैपटॉप या फ़ोन पर वेब डैशबोर्ड से संभालते हैं।' },
      { q: 'अगर किसी के पास स्मार्टफ़ोन नहीं है?', a: 'एडमिन डैशबोर्ड से उनकी हाज़िरी जोड़ या सुधार सकता है। सुधार और उसका कारण ऑडिट लॉग में सेव होता है।' },
      { q: 'क्या स्टाफ़ घर से हाज़िरी लगा सकता है?', a: 'नहीं। हाज़िरी तभी खुलती है जब फ़ोन की लोकेशन आपके तय किए दायरे के अंदर पक्की हो।' },
      { q: 'साइट पर इंटरनेट न हो तो?', a: 'ऐप रीडिंग फ़ोन में रखता है और कनेक्शन लौटने पर असली समय के साथ भेज देता है।' },
      { q: 'क्या इससे बैटरी खत्म होगी या घर पर भी ट्रैकिंग होगी?', a: 'ट्रैकिंग सिर्फ़ कर्मचारी की शुरू की गई शिफ़्ट में चलती है और शिफ़्ट खत्म होते ही रुक जाती है। शिफ़्ट के बाहर कुछ नहीं लिया जाता।' },
      { q: 'सेटअप में कितना समय लगता है?', a: 'एक कार्यस्थल और कुछ कर्मचारी जोड़ने में आमतौर पर कुछ ही मिनट लगते हैं। मुफ़्त अकाउंट बनाएँ, डैशबोर्ड पाँच आसान कदम में मदद करता है।' },
    ],
  },
  cta: { title: '15 मिनट से कम में अपनी टीम सेट करें', lead: 'कंपनी अकाउंट बनाएँ, मैप पर कार्यस्थल जोड़ें, स्टाफ़ इम्पोर्ट करें, और वे आज ही अपने फ़ोन से हाज़िरी लगाएँ।', primary: 'मुफ़्त अकाउंट बनाएँ', talk: 'हमसे बात करें' },
  footer: {
    tagline: 'हाज़िरी, मौजूदगी के सबूत के साथ।',
    by: 'एक प्रोडक्ट',
    product: 'प्रोडक्ट',
    contact: 'संपर्क',
    whatsapp: 'WhatsApp',
    rights: 'सर्वाधिकार सुरक्षित।',
  },
};

export const copy: Record<Lang, Copy> = { en, hi };
