// pages/legal/legal.js
Page({
  data: {
    activeDoc: 'privacy',
    sections: [],

    privacyPolicy: [
      { title: '1. Introduction', body: '"The List" ("we", "us", "our") operates this WeChat Mini Program to help you discover and register for nightlife events. This Privacy Policy explains what information we collect, how we use it, and your choices.' },
      { title: '2. Information We Collect', body: 'Phone number: obtained via WeChat\'s official phone number authorization, used to verify your identity and contact you about events you register for.\n\nProfile name: the nickname you provide when creating your profile.\n\nPromo code and promoter information: if someone invited you, we record the promo code used and the name of the promoter, to credit referrals correctly.\n\nEvent registration history: which events you register for, ticket type, and registration status.\n\nTechnical identifiers: WeChat provides us with an anonymous identifier (OpenID) associated with your WeChat account, used to recognize you across sessions. We do not have access to your WeChat password or other WeChat account details.' },
      { title: '3. How We Use Your Information', body: 'To create and manage your guest profile.\n\nTo register you for events and manage your guest list status.\n\nTo verify and credit promoter referrals.\n\nTo communicate with you about events you\'ve registered for.\n\nTo allow event staff to check you in at the venue.' },
      { title: '4. How We Share Your Information', body: 'With the venues and event organizers hosting events you register for, solely for guest list and check-in purposes.\n\nWith WeChat Cloud (Tencent CloudBase), our hosting provider, which stores this data on our behalf under its own security safeguards.\n\nWe do not sell your personal information to third parties, and we do not use it for advertising.' },
      { title: '5. Data Storage and Security', body: 'Your information is stored using WeChat Cloud infrastructure. We take reasonable measures to protect your data, but no method of transmission or storage is 100% secure.' },
      { title: '6. Your Choices', body: 'You can update your profile name at any time from the Profile page.\n\nYou can request deletion of your account and associated data by contacting us (see Contact section).\n\nYou may use the app without signing in, though registering for events requires providing your phone number.' },
      { title: '7. Children\'s Privacy', body: 'This app is intended for users who meet the minimum legal age for nightlife venue entry in their jurisdiction. We do not knowingly collect information from children.' },
      { title: '8. Changes to This Policy', body: 'We may update this Privacy Policy from time to time. Continued use of the app after changes constitutes acceptance of the updated policy.' },
      { title: '9. Contact Us', body: 'If you have questions about this Privacy Policy or wish to exercise your data rights, please contact us via our official WeChat account.' }
    ],
    termsOfService: [
      { title: '1. Acceptance of Terms', body: 'By using this Mini Program, you agree to these Terms of Service and our Privacy Policy. If you do not agree, please do not use the app.' },
      { title: '2. Description of Service', body: '"The List" allows you to browse upcoming nightlife events, register to be added to a venue\'s guest list, and manage your event registrations.' },
      { title: '3. Eligibility', body: 'You must meet the minimum legal age required to enter nightlife venues in your jurisdiction to use this service. Some events may have additional age or entry requirements set by the venue.' },
      { title: '4. Account and Registration', body: 'You are responsible for providing accurate information when registering. Sharing your account or promo code fraudulently, or attempting to register multiple times for the same event to circumvent capacity limits, may result in your registration being cancelled.' },
      { title: '5. Event Registration and Entry', body: 'Registering through this app places you on a venue\'s guest list but does not guarantee entry. Entry is subject to the venue\'s own policies, capacity, and management discretion. Venues may refuse entry for any lawful reason, including but not limited to dress code, capacity limits, or venue rules.' },
      { title: '6. Promoters and Promo Codes', body: 'Promo codes are provided by promoters affiliated with specific venues or events. We are not responsible for any arrangements between you and a promoter outside of the guest list registration itself.' },
      { title: '7. Cancellations', body: 'We reserve the right to remove your registration from an event\'s guest list, including in cases of suspected fraud, abuse, or venue request.' },
      { title: '8. Limitation of Liability', body: 'The app is provided "as is." We are not liable for any issues arising at the venue itself, including but not limited to denied entry, venue closures, or event cancellations. Our role is limited to facilitating guest list registration.' },
      { title: '9. Changes to These Terms', body: 'We may update these Terms from time to time. Continued use of the app after changes constitutes acceptance.' },
      { title: '10. Contact', body: 'For questions about these Terms, please contact us via our official WeChat account.' }
    ]
  },

  onLoad(options) {
    const doc = (options && options.doc === 'terms') ? 'terms' : 'privacy';
    this._setActiveDoc(doc);
  },

  // Splits each section's body on blank lines so the WXML side can render
  // one <text class="legal-para"> per paragraph — the classic WXML engine
  // doesn't turn \n into a line break inside <text> by default.
  _setActiveDoc(doc) {
    const source = doc === 'terms' ? this.data.termsOfService : this.data.privacyPolicy;
    const sections = source.map((item) => ({
      title: item.title,
      paragraphs: item.body.split('\n\n')
    }));
    this.setData({ activeDoc: doc, sections });
  },

  switchTab(e) {
    const doc = e.currentTarget.dataset.doc;
    if (doc === this.data.activeDoc) return;
    this._setActiveDoc(doc);
  },

  goBack() {
    wx.navigateBack({
      fail: () => wx.reLaunch({ url: '/pages/feed/feed' }),
    });
  }
});
