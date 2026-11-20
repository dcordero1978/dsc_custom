import frappe
from frappe import _
from frappe.utils import flt

OPERACIONES = ("Cobro", "Pago")
FACTURAS = ("Sales Invoice", "Purchase Invoice")


@frappe.whitelist()
def get_reglas_retencion(company, operacion):
	"""Reglas activas de retención de una empresa para Cobro (cliente) o Pago (proveedor).

	Devuelve {"reglas": {"IR": {"tasa": 2, "cuenta": "..."}, ...}, "cost_center": "..."}.
	Las tasas y cuentas salen de "DSC Retencion Config"; nada va fijo en el código.
	"""
	frappe.has_permission("Payment Entry", "read", throw=True)
	if operacion not in OPERACIONES:
		frappe.throw(_("Operación inválida: {0}").format(operacion))

	reglas = {}
	if frappe.db.exists("DSC Retencion Config", company):
		config = frappe.get_doc("DSC Retencion Config", company)
		for r in config.reglas:
			if r.operacion == operacion and r.activo:
				reglas[r.concepto] = {"tasa": flt(r.tasa), "cuenta": r.cuenta}

	return {
		"reglas": reglas,
		"cost_center": frappe.get_cached_value("Company", company, "cost_center"),
	}


@frappe.whitelist()
def get_base_retencion(referencias):
	"""Base de retención: subtotal SIN IVA y con el descuento ya aplicado (net total).

	Para cada factura referenciada se toma su net total en proporción a lo asignado
	en el pago (asignado / total de la factura), de modo que los pagos parciales
	retienen solo sobre la parte que se está pagando.
	"""
	frappe.has_permission("Payment Entry", "read", throw=True)
	referencias = frappe.parse_json(referencias) or []

	base = 0.0
	ignoradas = []
	for ref in referencias:
		doctype = ref.get("reference_doctype")
		nombre = ref.get("reference_name")
		asignado = flt(ref.get("allocated_amount"))

		if doctype not in FACTURAS or not nombre:
			ignoradas.append(nombre or doctype or "?")
			continue

		frappe.has_permission(doctype, "read", doc=nombre, throw=True)
		f = frappe.db.get_value(
			doctype,
			nombre,
			["base_net_total", "base_rounded_total", "base_grand_total", "docstatus"],
			as_dict=True,
		)
		if not f or f.docstatus != 1:
			ignoradas.append(nombre)
			continue

		total = flt(f.base_rounded_total) or flt(f.base_grand_total)
		if not total:
			ignoradas.append(nombre)
			continue

		base += flt(f.base_net_total) * asignado / total

	return {"base": flt(base, 2), "ignoradas": ignoradas}
