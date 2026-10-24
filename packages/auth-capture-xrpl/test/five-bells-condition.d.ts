declare module "five-bells-condition" {
  interface PreimageSha256Fulfillment {
    setPreimage(preimage: Buffer): void;
    getConditionBinary(): Buffer;
    serializeBinary(): Buffer;
  }
  const cc: { PreimageSha256: new () => PreimageSha256Fulfillment };
  export default cc;
}
