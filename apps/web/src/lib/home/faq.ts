/**
 * FAQ del Home · F-037 / FR-030 (PRD:1047-1052). CONFIRMED `[APP Home.js]`.
 *
 * **Copy literal.** Categorías y preguntas están copiadas carácter a carácter
 * del PRD. No se corrigen ni las comillas ni el inglés británico
 * (`Optimising`): el PRD marca esta tabla como copy del producto original.
 *
 * **Dos huecos que hay que saber:**
 *
 * 1. El PRD §23 (PRD:3486) titula esta feature "FAQ (5 categorías, 37 preguntas)",
 *    pero la lista de FR-030 enumera **39**. Se copian las 39 que están escritas:
 *    inventar dos o borrar dos para cuadrar el número sería peor. El que
 *    reconcilie el número tiene que ir al producto original, no a este archivo.
 * 2. **El PRD no trae ninguna respuesta.** Sólo las preguntas. Por eso
 *    `answer` no existe en este tipo y el acordeón abre a un aviso explícito en
 *    vez de a un texto inventado.
 */

export interface FaqCategory {
  /** Título de la categoría, en mayúsculas como en el producto. */
  readonly title: string;
  readonly questions: readonly string[];
}

export const HOME_FAQ = [
  {
    title: "WARMING UP YOUR ACCOUNT",
    questions: [
      "How do I warm up my account?",
      'How do I navigate "zero view jail"?',
      "What should I actually do in the first few weeks?",
      "Why are my first few posts getting low views?",
    ],
  },
  {
    title: "WHY THIS TYPE OF CONTENT",
    questions: [
      "Why can I only make slideshows, wall of text, hook and demo, and green screen memes?",
      "Why are slideshows so effective?",
      "Why is wall of text so effective?",
      "Why are hook demo videos so effective?",
      "Why are green screen memes so effective?",
    ],
  },
  {
    title: "CREATING AND REMIXING CONTENT",
    questions: [
      "How does Remix work?",
      "What if the trending content in Fastlane isn't in my niche? Should I still remix it?",
      "How do I create a product demo video?",
      "Can I upload my own media/videos/images?",
      "Can I generate my own AI avatars for UGC videos?",
      "Are you going to add more content formats?",
      "Why does editing my content sometimes create a new post instead of updating the original?",
      'What if I get a "post failed" error?',
      "What are the platform rules around copyright?",
      "How do I get support from the team?",
    ],
  },
  {
    title: "OPTIMISING YOUR GROWTH STRATEGY",
    questions: [
      "How quickly should I expect results?",
      "How many videos should I be posting per day?",
      "Do I need an existing audience for this to work?",
      "Should I post the same video across all platforms?",
      "How should I be mentioning my product?",
      "How do I hit 1,000 views consistently?",
      "Should I use hashtags? Which ones should I use?",
      "Should you only post one content format per account for maximum algorithm benefit?",
      "What if I run out of ideas?",
      "Does posting at a certain time of day impact performance?",
    ],
  },
  {
    title: "ACCOUNTS AND WORKSPACES",
    questions: [
      "How many TikTok, Instagram, or YouTube accounts can I connect?",
      "How can I add multiple social media accounts?",
      "How can I connect another one of my businesses to Fastlane?",
      "What's the difference between a personal account and a business account on TikTok?",
      "What's the difference between a creator account and a business account on Instagram?",
      "What's the difference between a personal account and a brand account on YouTube?",
      "What are the TikTok posting limits?",
      "What are the Instagram posting limits?",
      "What are the YouTube posting limits?",
      "What happens if I hit a posting limit?",
    ],
  },
] as const satisfies readonly FaqCategory[];

/** 39 hoy. Se calcula, no se escribe: un número a mano se desincroniza. */
export const HOME_FAQ_QUESTION_COUNT = HOME_FAQ.reduce(
  (total, category) => total + category.questions.length,
  0,
);
