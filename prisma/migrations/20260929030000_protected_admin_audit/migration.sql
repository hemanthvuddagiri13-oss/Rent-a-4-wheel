CREATE FUNCTION protected_admin_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.action LIKE 'protected.admin.%' THEN RAISE EXCEPTION 'Protected administrative audit is immutable'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protected_admin_audit_guard BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION protected_admin_audit_immutable();
