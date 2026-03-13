// netlify/functions/analyze.js
// Receives base64-encoded image(s), calls Claude, returns season JSON

const { Anthropic } = require('@anthropic-ai/sdk');

const SYSTEM_PROMPT = `You are an expert color analyst with deep knowledge of the 12-season color analysis system. You are analyzing photo(s) of a person's face to determine their color season. Examine their skin undertone (warm/cool/neutral), skin value (light/medium/deep), hair color and its warmth or coolness, and eye color. Consider how these features interact.

The 12 seasons are:
Spring family (warm, clear): Light Spring, True Spring, Bright Spring
Summer family (cool, muted): Light Summer, True Summer, Soft Summer
Autumn family (warm, muted): Soft Autumn, True Autumn, Dark Autumn
Winter family (cool, clear): True Winter, Deep Winter, Bright Winter

The most common misclassification errors are between seasons that share one trait. Pay special attention to:

- Light Spring vs Light Summer: Both are light-value, but Light Spring has warm golden or peachy undertones and warm-toned hair (golden, strawberry, or warm blonde), while Light Summer has cool or neutral-pink undertones and cool-toned or ashy hair.
- True Spring vs True Autumn: Both are warm, but True Spring is clear and bright while True Autumn is muted and earthy. Clear, saturated, jewel-toned eyes indicate Spring; soft, low-contrast, muted coloring indicates Autumn.
- Bright Winter vs Bright Spring: Both are high-chroma, but Bright Winter is cool or icy with blue-based clarity while Bright Spring is warm with golden or peachy warmth. A cool-blue sheen in the eyes or a blue-pink skin tone indicates Winter; golden warmth indicates Spring.

When determining undertone, use these visual cues:
- Vein color on the inner wrist: blue or purple suggests cool; green or olive suggests warm; blue-green suggests neutral
- The warmth or coolness of hair: golden, red, or strawberry tones are warm; ash, cool brown, or platinum are cool
- Skin tone in natural light: pink, beige-pink, or rosy tones suggest cool; yellow, golden, or peachy tones suggest warm; olive or beige with a mix of both suggests neutral

Always identify undertone first, then value (light/deep), then chroma (clear/muted). Season follows from those three traits — do not guess the season directly. State your undertone reading explicitly in feature_notes and explain what specific visual evidence led you to that conclusion.

Return ONLY a valid JSON object with no markdown, no preamble, in exactly this structure:
{
"season": "Light Spring",
"family": "Spring",
"confidence": 0.85,
"dominant_trait": "Light",
"secondary_trait": "Neutral-Warm",
"undertone": "Neutral-Warm",
"value": "Light",
"chroma": "Clear",
"feature_notes": "2-3 sentences describing what specifically was observed in the photos — skin tone, hair, eyes",
"character_description": "One sentence capturing the essence of this season",
"best_colors": ["color name 1", "color name 2", "...at least 20 color names accurate to the season"],
"avoid_colors": ["color name 1", "...at least 8 color names to avoid"],
"best_neutrals": ["neutral 1", "neutral 2", "neutral 3", "neutral 4"],
"choose_over": [{"choose": "flamingo pink", "over": "berry"}, "...at least 10 pairs accurate to the season"],
"patterns": "2-3 sentences on patterns that suit this season",
"hair": "2-3 sentences on hair color guidance",
"makeup": "2-3 sentences on makeup colors",
"accessories": "1-2 sentences on metals and accessories",
"sister_season": "season name",
"neighboring_seasons": ["season name", "season name"],
"color_mantra": "3-5 word phrase capturing the season essence e.g. Light and Bright Pastels"
}`;

function buildImageContent(images) {
  const content = [];
  images.forEach((img, i) => {
    if (images.length > 1) {
      content.push({ type: 'text', text: `Photo ${i + 1} of ${images.length}:` });
    }
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    });
  });
  return content;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Parse body ──
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { images } = body;
  if (!images || !Array.isArray(images) || images.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'At least one image is required' }) };
  }
  if (images.length > 3) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Maximum 3 images allowed' }) };
  }

  // ── Validate each image ──
  for (const img of images) {
    if (!img.data || !img.mediaType) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Each image must have data and mediaType fields' }) };
    }
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(img.mediaType)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unsupported media type: ${img.mediaType}` }) };
    }
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // ── Build primary message content ──
  const userContent = buildImageContent(images);
  userContent.push({
    type: 'text',
    text: images.length > 1
      ? 'Please analyze all of these photos together to determine this person\'s color season. Use all photos to inform your assessment.'
      : 'Please analyze this photo to determine this person\'s color season.',
  });

  // ── Call Claude — Primary Analysis ──
  let result;
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    const text = message.content.map(b => b.text || '').join('').trim();
    // Strip any accidental markdown fences
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    result = JSON.parse(clean);

  } catch (err) {
    console.error('Claude primary error:', err);

    // JSON parse failure — Claude may have been uncertain
    if (err instanceof SyntaxError) {
      return {
        statusCode: 422,
        headers,
        body: JSON.stringify({
          error: 'photo_quality',
          message: 'We weren\'t able to determine your season from these photos. This usually happens when the lighting is too dim, the face isn\'t fully visible, or there\'s heavy filtering. Please try again with a clearer photo in natural light.',
        }),
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'server_error',
        message: 'Something went wrong on our end. Please try again in a moment.',
      }),
    };
  }

  // ── Validate minimum required fields ──
  const required = ['season', 'family', 'confidence', 'best_colors', 'avoid_colors'];
  for (const field of required) {
    if (!result[field]) {
      return {
        statusCode: 422,
        headers,
        body: JSON.stringify({
          error: 'incomplete_result',
          message: 'The analysis returned incomplete data. Please try again.',
        }),
      };
    }
  }

  // ── Very low confidence — cannot give a reliable reading ──
  if (result.confidence < 0.5) {
    return {
      statusCode: 422,
      headers,
      body: JSON.stringify({
        error: 'low_confidence',
        message: `We detected a possible ${result.season} season but aren't confident enough to give you a full analysis. The best results come from photos in natural daylight with no makeup and a plain background. Please try again with a clearer photo.`,
        season_hint: result.season,
        confidence: result.confidence,
      }),
    };
  }

  // ── Moderate confidence — needs one more photo before showing result ──
  if (result.confidence < 0.75) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        needs_more_photos: true,
        season_hint: result.season,
        confidence: result.confidence,
      }),
    };
  }

  // ── Verification call — second opinion on same images ──
  const verifyContent = buildImageContent(images);
  verifyContent.push({
    type: 'text',
    text: `A color analyst has determined this person is ${result.season}. Do you agree? If not, what season would you assign and why? Look specifically at undertone evidence.\n\nRespond ONLY with this JSON object (no markdown, no preamble):\n{\n  "agree": true,\n  "season": "${result.season}",\n  "reasoning": "Your reasoning here"\n}\nIf you disagree, set "agree" to false and update "season" to the season you would assign.`,
  });

  let verification;
  try {
    const verifyMsg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [{ role: 'user', content: verifyContent }],
    });
    const verifyText = verifyMsg.content.map(b => b.text || '').join('').trim();
    const verifyClean = verifyText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    verification = JSON.parse(verifyClean);
  } catch (err) {
    console.error('Claude verification error:', err);
    // Verification failed — return primary result without borderline info
    verification = { agree: true, season: result.season, reasoning: '' };
  }

  // ── Combine primary + verification ──
  if (!verification.agree && verification.season && verification.season !== result.season) {
    result.borderline = true;
    result.borderline_season = verification.season;
    result.borderline_note = verification.reasoning
      || `Our analysis flagged this as a close call between ${result.season} and ${verification.season}. Both are valid readings of your coloring — the difference often comes down to subtle undertone cues that are easier to read in person.`;
  } else {
    result.borderline = false;
  }

  return { statusCode: 200, headers, body: JSON.stringify(result) };
};
