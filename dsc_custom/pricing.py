"""Margen sobre venta (gross margin) en Pricing Rule.

ERPNext solo sabe calcular el precio con markup (margen sobre el precio de lista):
    precio = lista * (1 + markup/100)

El margen sobre venta es otra definicion de ganancia (porcentaje del PRECIO DE VENTA):
    precio = lista / (1 - margen/100)

Ambas son la misma cuenta si se usa el markup equivalente:
    markup = margen / (100 - margen) * 100      (30% de margen = 42.857143% de markup)

Por eso, al guardar una Pricing Rule con tipo de margen "Margen sobre Venta", se guarda
convertida: margin_type = "Percentage" y margin_rate_or_amount = markup equivalente. El core
de ERPNext (servidor y navegador) calcula el precio sin ningun cambio. El margen original queda
en dsc_margen_venta para que el formulario lo muestre tal como lo escribio el usuario.
"""

import frappe
from frappe import _
from frappe.utils import flt

MARGEN_SOBRE_VENTA = "Margen sobre Venta"

# Tolerancia (en puntos porcentuales) para saber si el markup guardado sigue siendo el
# equivalente del margen original. El markup se guarda con 6 decimales.
TOLERANCIA = 0.0001


def markup_equivalente(margen):
	return margen / (100 - margen) * 100


def convertir_margen_sobre_venta(doc, method=None):
	"""before_validate de Pricing Rule."""
	if doc.margin_type == MARGEN_SOBRE_VENTA:
		margen = flt(doc.margin_rate_or_amount)

		if not 0 < margen < 100:
			frappe.throw(_("El margen sobre venta debe ser mayor que 0 y menor que 100."))
		if doc.buying or not doc.selling:
			frappe.throw(_("El margen sobre venta aplica solo a ventas: marque Ventas y desmarque Compras."))
		if doc.price_or_product_discount != "Price":
			frappe.throw(_("El margen sobre venta solo se puede usar en reglas de tipo Precio."))

		doc.dsc_margen_venta = margen
		doc.margin_type = "Percentage"
		doc.margin_rate_or_amount = markup_equivalente(margen)
		return

	# Otro tipo de margen. Se conserva la marca solo si la regla sigue siendo la convertida
	# (por ejemplo, una regla ya convertida que se vuelve a guardar por API).
	previo = flt(doc.get("dsc_margen_venta"))
	if (
		previo
		and 0 < previo < 100
		and doc.margin_type == "Percentage"
		and abs(flt(doc.margin_rate_or_amount) - markup_equivalente(previo)) <= TOLERANCIA
	):
		return

	doc.dsc_margen_venta = 0
