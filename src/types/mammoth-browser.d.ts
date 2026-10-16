/**
 * Ambient declaration for mammoth's prebuilt browser bundle
 * (`mammoth/mammoth.browser.js`), which has no bundled .d.ts. Only the
 * surface this repo uses is declared.
 */
declare module 'mammoth/mammoth.browser.js' {
  export interface MammothResult {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }
  export interface MammothInput {
    arrayBuffer: ArrayBuffer;
  }
  const mammoth: {
    convertToHtml: (input: MammothInput) => Promise<MammothResult>;
    convertToMarkdown: (input: MammothInput) => Promise<MammothResult>;
    extractRawText: (input: MammothInput) => Promise<MammothResult>;
  };
  export default mammoth;
}
