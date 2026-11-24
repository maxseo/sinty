/** Internal capability: never deserialized from a request body. */
export interface CatalogProofData {
    dir: string;
    treeHash: string;
    name: string;
    version: string;
    artifactSha256: string;
    publisher: string;
    catalogUrl: string;
    catalogSequence: number;
}
const proofs = new WeakMap<object, CatalogProofData>();
export function issueCatalogProof(data: CatalogProofData): object { const proof = Object.freeze({}); proofs.set(proof, data); return proof; }
export function catalogProof(proof: object | undefined): CatalogProofData | undefined { return proof ? proofs.get(proof) : undefined; }
