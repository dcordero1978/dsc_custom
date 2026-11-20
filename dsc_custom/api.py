"""Retenciones en Payment Entry (Nicaragua, configurable por empresa).

Las reglas salen de "DSC Retencion Config" (una por empresa). Cada regla define:
  operacion     Cobro (el cliente le retiene a la empresa) o Pago (la empresa le retiene al proveedor)
  concepto      IR o ALMA
  tasa          porcentaje de retención
  cuenta        cuenta contable (Cobro -> activo, Pago -> pasivo)
  monto_minimo  la factura entra en la base solo si su valor es >= este monto (0 = sin límite)
  base_calculo  valor de la factura que se usa para el mínimo y para calcular:
                "Subtotal sin IVA" (net total, con descuento) o "Total con IVA" (grand total)

El mínimo se evalúa POR FACTURA, no sobre la suma del pago. Una factura que alcanza el mínimo
retiene sobre la parte que se está pagando (asignado / total de la factura).
"""

import frappe
from frappe import _
from frappe.utils import flt

OPERACIONES = ("Cobro", "Pago")
FACTURAS = ("Sales Invoice", "Purchase Invoice")
BASE_SUBTOTAL = "Subtotal sin IVA"
BASE_TOTAL = "Total con IVA"
CAMPO_RETENER = {"IR": "dsc_retencion_ir", "ALMA": "dsc_retencion_alma"}
CAMPO_DOCUMENTO = {"IR": "dsc_documento_ir", "ALMA": "dsc_documento_alma"}
ENTIDAD = {"IR": "DGI", "ALMA": "alcaldía"}


def operacion_de(payment_type, party_type):
	if payment_type == "Receive" and party_type == "Customer":
		return "Cobro"
	if payment_type == "Pay" and party_type == "Supplier":
		return "Pago"
	return None


def reglas_activas(company, operacion):
	reglas = {}
	if company and frappe.db.exists("DSC Retencion Config", company):
		for r in frappe.get_doc("DSC Retencion Config", company).reglas:
			if r.operacion == operacion and r.activo:
				reglas[r.concepto] = frappe._dict(
					tasa=flt(r.tasa),
					cuenta=r.cuenta,
					monto_minimo=flt(r.get("monto_minimo")),
					base_calculo=r.get("base_calculo") or BASE_SUBTOTAL,
				)
	return reglas


def _cargar_facturas(referencias):
	"""Facturas validadas referenciadas en el pago, con sus montos en moneda de la empresa."""
	facturas, ignoradas = [], []
	for ref in referencias:
		doctype = ref.get("reference_doctype")
		nombre = ref.get("reference_name")
		if doctype not in FACTURAS or not nombre:
			ignoradas.append(nombre or doctype or "?")
			continue

		frappe.has_permission(doctype, "read", doc=nombre, throw=True)
		f = frappe.db.get_value(
			doctype,
			nombre,
			["base_net_total", "base_grand_total", "base_rounded_total", "docstatus"],
			as_dict=True,
		)
		total = (flt(f.base_rounded_total) or flt(f.base_grand_total)) if f else 0
		if not f or f.docstatus != 1 or not total:
			ignoradas.append(nombre)
			continue

		facturas.append(
			frappe._dict(
				nombre=nombre,
				asignado=flt(ref.get("allocated_amount")),
				total=total,
				subtotal=flt(f.base_net_total),
				total_con_iva=flt(f.base_grand_total),
			)
		)
	return facturas, ignoradas


def aporte_factura(factura, regla):
	"""(valor de la factura según la base, ¿alcanza el mínimo?, aporte a la base de este pago)."""
	valor = factura.total_con_iva if regla.base_calculo == BASE_TOTAL else factura.subtotal
	aplica = valor >= regla.monto_minimo
	aporte = valor * factura.asignado / factura.total if aplica and factura.total else 0.0
	return valor, aplica, aporte


def calcular(company, operacion, referencias):
	reglas = reglas_activas(company, operacion)
	facturas, ignoradas = _cargar_facturas(referencias)
	conceptos = {}
	for concepto, regla in reglas.items():
		base = 0.0
		detalle = []
		for fac in facturas:
			valor, aplica, aporte = aporte_factura(fac, regla)
			base += aporte
			detalle.append({"factura": fac.nombre, "valor": flt(valor, 2), "aplica": aplica})
		base = flt(base, 2)
		conceptos[concepto] = {
			"tasa": regla.tasa,
			"cuenta": regla.cuenta,
			"monto_minimo": regla.monto_minimo,
			"base_calculo": regla.base_calculo,
			"base": base,
			"monto": flt(base * regla.tasa / 100, 2),
			"facturas": detalle,
		}
	return conceptos, ignoradas


def _validar_operacion(operacion):
	if operacion not in OPERACIONES:
		frappe.throw(_("Operación inválida: {0}").format(operacion))


@frappe.whitelist()
def get_reglas_retencion(company, operacion):
	"""Reglas activas de la empresa para Cobro o Pago (para mostrar etiquetas en el formulario)."""
	frappe.has_permission("Payment Entry", "read", throw=True)
	_validar_operacion(operacion)
	return {
		"reglas": reglas_activas(company, operacion),
		"cost_center": frappe.get_cached_value("Company", company, "cost_center"),
	}


@frappe.whitelist()
def calcular_retenciones(company, operacion, referencias):
	"""Base y monto de cada retención para las facturas referenciadas en el pago."""
	frappe.has_permission("Payment Entry", "read", throw=True)
	_validar_operacion(operacion)
	conceptos, ignoradas = calcular(company, operacion, frappe.parse_json(referencias) or [])
	return {
		"conceptos": conceptos,
		"ignoradas": ignoradas,
		"cost_center": frappe.get_cached_value("Company", company, "cost_center"),
	}


def validar_documentos_retencion(doc, method=None):
	"""before_submit de Payment Entry: exige el documento de respaldo de cada retención.

	Cobro: si se retuvo IR o ALMA, la constancia que entregó el cliente.
	Pago:  si alguna factura alcanza el mínimo y NO se retuvo, la exoneración del proveedor.
	       Si se retuvo, el documento es opcional (constancia que emite la empresa).
	"""
	operacion = operacion_de(doc.payment_type, doc.party_type)
	if not operacion:
		return
	reglas = reglas_activas(doc.company, operacion)
	if not reglas:
		return

	faltan = []
	calculo = None
	for concepto in reglas:
		if doc.get(CAMPO_DOCUMENTO[concepto]):
			continue
		retenido = doc.get(CAMPO_RETENER[concepto])

		if operacion == "Cobro":
			if retenido:
				faltan.append(
					_("Constancia de retención {0} ({1}) que entregó el cliente.").format(concepto, ENTIDAD[concepto])
				)
		elif not retenido:
			if calculo is None:
				calculo, _ignoradas = calcular(
					doc.company, operacion, [r.as_dict() for r in (doc.get("references") or [])]
				)
			if any(f["aplica"] for f in calculo.get(concepto, {}).get("facturas", [])):
				faltan.append(
					_(
						"Exoneración de {0} que presentó el proveedor: hay facturas desde el monto mínimo y no se retuvo {0}."
					).format(concepto)
				)

	if faltan:
		frappe.throw(
			_("Adjunte los documentos de retención antes de validar el pago:")
			+ "<ul>"
			+ "".join("<li>" + f + "</li>" for f in faltan)
			+ "</ul>",
			title=_("Falta documento de retención"),
		)
