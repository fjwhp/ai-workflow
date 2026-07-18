export function groupReworkItems(items:any[]=[]){return ["S0","S1","S2","S3"].map(severity=>({severity,items:items.filter(item=>item.severity===severity)})).filter(group=>group.items.length)}
