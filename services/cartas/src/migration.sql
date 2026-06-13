-- ============================================================
-- Migración: Cartas de Aprobación (desde Supabase → TiDB)
-- ============================================================

CREATE TABLE IF NOT EXISTS cartas_ejecutivos (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(150) NOT NULL,
  mail          VARCHAR(150) DEFAULT NULL,
  tel           VARCHAR(30)  DEFAULT NULL,
  activo        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cartas_parametros (
  `key`         VARCHAR(100) NOT NULL PRIMARY KEY,
  `value`       LONGTEXT     NOT NULL,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by    VARCHAR(150) DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS cartas_aprobacion (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  op_carta                  VARCHAR(30)   DEFAULT NULL,
  id_financiera             VARCHAR(50)   DEFAULT NULL,
  tipo                      VARCHAR(50)   DEFAULT NULL,
  ejecutivo_idx             INT           DEFAULT NULL,
  ejecutivo_nombre          VARCHAR(150)  DEFAULT NULL,
  ejecutivo_mail            VARCHAR(150)  DEFAULT NULL,
  ejecutivo_tel             VARCHAR(30)   DEFAULT NULL,
  cliente                   VARCHAR(200)  DEFAULT NULL,
  rut_cliente               VARCHAR(20)   DEFAULT NULL,
  tipo_vehiculo             VARCHAR(50)   DEFAULT NULL,
  marca                     VARCHAR(100)  DEFAULT NULL,
  modelo                    VARCHAR(100)  DEFAULT NULL,
  anio                      VARCHAR(10)   DEFAULT NULL,
  patente                   VARCHAR(20)   DEFAULT NULL,
  prenda                    VARCHAR(10)   DEFAULT NULL,
  precio_venta              BIGINT        DEFAULT NULL,
  pie                       BIGINT        DEFAULT NULL,
  saldo                     BIGINT        DEFAULT NULL,
  plazo                     INT           DEFAULT NULL,
  acreedor                  VARCHAR(100)  DEFAULT NULL,
  parque                    VARCHAR(150)  DEFAULT NULL,
  nombre_dealer             VARCHAR(200)  DEFAULT NULL,
  rut_dealer                VARCHAR(20)   DEFAULT NULL,
  vendedor                  VARCHAR(150)  DEFAULT NULL,
  part_neto                 BIGINT        DEFAULT NULL,
  part_iva                  BIGINT        DEFAULT NULL,
  part_bruto                BIGINT        DEFAULT NULL,
  fecha                     DATE          DEFAULT NULL,
  fecha_creacion            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  creado_por                VARCHAR(150)  DEFAULT NULL,
  creado_por_nombre         VARCHAR(200)  DEFAULT NULL,
  creado_por_initials       VARCHAR(10)   DEFAULT NULL,
  status                    VARCHAR(30)   NOT NULL DEFAULT 'PENDIENTE',
  aprobado_por              VARCHAR(150)  DEFAULT NULL,
  aprobado_por_nombre       VARCHAR(200)  DEFAULT NULL,
  aprobado_por_initials     VARCHAR(10)   DEFAULT NULL,
  fecha_aprobacion          DATETIME      DEFAULT NULL,
  rechazado_por             VARCHAR(150)  DEFAULT NULL,
  rechazado_por_nombre      VARCHAR(200)  DEFAULT NULL,
  fecha_rechazo             DATETIME      DEFAULT NULL,
  motivo_rechazo            TEXT          DEFAULT NULL,
  anulado_por               VARCHAR(150)  DEFAULT NULL,
  fecha_anulacion           DATETIME      DEFAULT NULL,
  eliminado_por             VARCHAR(150)  DEFAULT NULL,
  fecha_eliminacion         DATETIME      DEFAULT NULL,
  fecha_correccion          DATETIME      DEFAULT NULL,
  corregido_por             VARCHAR(150)  DEFAULT NULL,
  otorgado                  TINYINT(1)    NOT NULL DEFAULT 0,
  fecha_otorgado            DATETIME      DEFAULT NULL,
  tasa_credito              DECIMAL(8,4)  DEFAULT NULL,
  monto_credito_clp         BIGINT        DEFAULT NULL,
  monto_credito_uf          DECIMAL(12,4) DEFAULT NULL,
  excepciones               JSON          DEFAULT NULL,
  excepciones_comentarios   JSON          DEFAULT NULL,

  INDEX idx_status      (status),
  INDEX idx_fecha       (fecha),
  INDEX idx_rut_cliente (rut_cliente),
  INDEX idx_creado_por  (creado_por)
);
