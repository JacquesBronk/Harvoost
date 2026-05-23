export interface HarvestColumn {
    key: string;
    header: string;
    width: number;
    financialOnly?: boolean;
}
export declare const HARVEST_COLUMNS: ReadonlyArray<HarvestColumn>;
export declare function columnsForRole(canSeeFinancial: boolean): ReadonlyArray<HarvestColumn>;
//# sourceMappingURL=HarvestExportSchema.d.ts.map