CGBC Quote Review Fresh Rebuild

Replace only:
  quote-review.html
  quote-review-approved.html
  quote-review-denied.html

Do NOT replace approved-quotes-random.html. Quote Wall is intentionally untouched.

Built from scratch using uploaded data shapes:
- random-quotes.json / quote-bank.json quote candidates
- config/quote-curation.json review decisions
- CGBC player deep link pattern: index.html?mode=video&item=<episode-stable-id>

Features:
- Shared password/session across all three admin pages.
- Repo curation JSON + local browser decisions layered together.
- Export/download quote-curation.json from Review, Approved, and Denied pages.
- Quote Review: Episode filter, Review status filter, left/right review+media layout, Add Previous/Add Next, Previous/Next Quote, Reject/Approve/Feature, video preview.
- Approved Quotes: approved+featured list, edit/save/copy/reject/feature, copy includes Pastor Jacob Lannom and CGBC player video-at-zero link.
- Denied Quotes: rejected list, editable quote field, save/approve/feature.

JavaScript syntax checked for all three files.
