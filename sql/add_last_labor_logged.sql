ALTER TABLE EtlStateLimbleTables
ADD LastLaborLogged datetime2 NOT NULL DEFAULT ('1970-01-01');
