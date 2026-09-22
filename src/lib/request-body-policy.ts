export const JSON_BODY_LIMIT=24000;
export const MULTIPART_BODY_LIMIT=9*1024*1024; // 8 MB file plus bounded multipart fields.
export function requestBodyLimit(pathname:string,contentType:string|null,machine:boolean){
 if(/^\/api\/v1\/mobile\/uploads\/[^/]+\/finalize$/.test(pathname))return 8*1024*1024;
 const upload=pathname==="/api/community"||pathname==="/api/host/files"||pathname==="/api/documents/upload"||/^\/api\/reservations\/[^/]+\/condition-reports$/.test(pathname);
 const multipart=/^multipart\/form-data\s*;/i.test(contentType??"");
 return upload&&multipart?MULTIPART_BODY_LIMIT:machine?1024*1024:JSON_BODY_LIMIT;
}
